#!/usr/bin/env bash
# Post a markdown file as an inline diff comment (a new discussion thread) on one line of a GitLab
# MR of the repo's origin. The line is a line of the file at the MR head (new side), or with --old
# a line of the file before the MR (old side, for removed lines). The diff position GitLab needs
# (base/start/head SHAs, old_line/new_line) is computed from the MR's diff_refs and local git, so
# run fetch-mr.sh first. Refuses when the MR head moved past the reviewed SHA.
# Token: see gitlab-lib.sh (`api` scope); never printed. Needs bash, git, curl and jq.
#
# Usage: post-mr-inline.sh <mr-number> <reviewed-sha> <path> <line> <body.md> [repo-dir] [--old] [--dry-run]
# Exit:  0 posted (or dry run) · 3 no token · 4 head moved · 5 position rejected / not computable · 1 error
set -euo pipefail
. "$(dirname "$0")/gitlab-lib.sh"

usage="usage: post-mr-inline.sh <mr-number> <reviewed-sha> <path> <line> <body.md> [repo-dir] [--old] [--dry-run]"
dry=0; side=new; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --old) side=old ;;
    *) args+=("$1") ;;
  esac
  shift
done
mr="${args[0]:?$usage}"; sha="${args[1]:?$usage}"; path="${args[2]:?$usage}"
line="${args[3]:?$usage}"; body="${args[4]:?$usage}"; repo="${args[5]:-.}"
mr="${mr#!}"; mr="${mr#\#}"; path="${path#./}"
[[ "$mr" =~ ^[0-9]+$ ]] || { echo "MR must be a number, got: $mr"; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Bad SHA: $sha"; exit 1; }
[[ "$line" =~ ^[0-9]+$ ]] && [ "$line" -gt 0 ] || { echo "Line must be a positive number, got: $line"; exit 1; }
[ -s "$body" ] || { echo "Body file is empty or missing: $body"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found (brew install jq)"; exit 1; }

gl_origin_parse "$repo"
gl_header_file || { echo "NO_TOKEN: $(gl_no_token_hint api)"; exit 3; }
api="$GL_API/merge_requests/$mr"
web="$GL_WEB/-/merge_requests/$mr"
g() { git -C "$repo" "$@"; }

resp=$(curl -sS -w '\n%{http_code}' "$api" -H @"$GL_HEADER_FILE")
code=${resp##*$'\n'}; info=${resp%$'\n'*}
[ "$code" = 200 ] || { echo "MR_FAILED: HTTP $code: ${info:0:300}"; exit 1; }
base=$(jq -r .diff_refs.base_sha <<<"$info"); start=$(jq -r .diff_refs.start_sha <<<"$info")
head=$(jq -r .diff_refs.head_sha <<<"$info")
[[ "$head" == "$sha"* ]] || { echo "HEAD_MOVED: MR head is $head, reviewed $sha; re-review before commenting"; exit 4; }
for c in "$base" "$head"; do
  g cat-file -e "$c^{commit}" 2>/dev/null || { echo "MISSING_COMMIT: $c not in $repo; run fetch-mr.sh $mr first"; exit 1; }
done

# old_path: the file's name before the MR (differs only on a rename)
old_path=$(g diff -M --name-status "$base" "$head" | awk -F'\t' -v p="$path" '
  $1 ~ /^R/ && ($3 == p || $2 == p) { print $2; found=1; exit }
  $2 == p { print p; found=1; exit }
  END { if (!found) print "" }')
[ -n "$old_path" ] || { echo "NOT_IN_DIFF: $path is not changed by this MR; GitLab accepts inline comments only on changed files"; exit 5; }
new_path=$path
[ "$side" = old ] && new_path=$(g diff -M --name-status "$base" "$head" | awk -F'\t' -v p="$path" '$1 ~ /^R/ && $2 == p { print $3; exit } END {}')
[ -n "$new_path" ] || new_path=$path
[ "$side" = old ] && old_path=$path

# Map the line through the -U0 hunks. A + line has only new_line, a - line only old_line, any
# other line (context or outside hunks) has both, offset by the lines added/removed above it.
pos=$(g diff -M -U0 "$base" "$head" -- "$old_path" "$new_path" | awk -v side="$side" -v L="$line" '
  /^@@/ {
    split($2, o, ","); split($3, n, ",")
    os = substr(o[1], 2) + 0; oc = (2 in o) ? o[2] + 0 : 1
    ns = substr(n[1], 2) + 0; nc = (2 in n) ? n[2] + 0 : 1
    # first line after the hunk on each side (an empty side names the line before the gap)
    oe = oc ? os + oc : os + 1; ne = nc ? ns + nc : ns + 1
    if (side == "new") {
      if (nc && L >= ns && L < ne) { print "new", L; done = 1; exit }
      if (L >= ne) delta = ne - oe
    } else {
      if (oc && L >= os && L < oe) { print "old", L; done = 1; exit }
      if (L >= oe) delta = ne - oe
    }
  }
  END {
    if (done) exit
    if (side == "new") print "both", L - delta, L
    else print "both", L, L + delta
  }')
read -r kind a b <<<"$pos"
form=(--data-urlencode "body@$body"
  --data-urlencode "position[position_type]=text"
  --data-urlencode "position[base_sha]=$base" --data-urlencode "position[start_sha]=$start"
  --data-urlencode "position[head_sha]=$head"
  --data-urlencode "position[old_path]=$old_path" --data-urlencode "position[new_path]=$new_path")
case "$kind" in
  new)  form+=(--data-urlencode "position[new_line]=$a"); desc="new line $a (added)" ;;
  old)  form+=(--data-urlencode "position[old_line]=$a"); desc="old line $a (removed)" ;;
  both) form+=(--data-urlencode "position[old_line]=$a" --data-urlencode "position[new_line]=$b"); desc="old line $a / new line $b (unchanged)" ;;
  *)    echo "POSITION_FAILED: could not map $path:$line"; exit 5 ;;
esac

echo "TARGET:   $web (inline, $new_path, $desc)"
echo "AT:       head $head"
echo "BODY:     $body ($(wc -c <"$body") bytes)"
if [ "$dry" = 1 ]; then echo "DRY_RUN: nothing posted"; exit 0; fi

resp=$(curl -sS -w '\n%{http_code}' -X POST "$api/discussions" -H @"$GL_HEADER_FILE" "${form[@]}")
code=${resp##*$'\n'}; out=${resp%$'\n'*}
case "$code" in
  201) id=$(jq -r '.notes[0].id' <<<"$out"); echo "POSTED: $web#note_$id" ;;
  400) echo "POSITION_REJECTED: HTTP 400: ${out:0:300}"; exit 5 ;;
  *)   echo "POST_FAILED: HTTP $code: ${out:0:300}"; exit 1 ;;
esac
