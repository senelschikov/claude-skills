#!/usr/bin/env bash
# Fetch a GitLab MR's metadata and all review discussions through the API (read-only). Same
# output as fetch-mr-discussions.ps1: target/source branch, state, head SHA, description size,
# then every human thread with file:line, resolved state, the commit it was written against, and
# all notes. Optionally saves the raw discussions JSON (--json-out) for scripted triage.
#
# OS detection: on Windows (Git Bash, no jq) it hands off to fetch-mr-discussions.ps1; on macOS
# and Linux it runs here with curl + jq. Token: see gitlab-lib.sh (`read_api`); never printed.
#
# Usage: fetch-mr-discussions.sh <mr-number> [repo-dir] [--json-out <file>]
# Exit:  0 ok · 3 no token · 1 error
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
. "$here/gitlab-lib.sh"

usage="usage: fetch-mr-discussions.sh <mr-number> [repo-dir] [--json-out <file>]"
json_out=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --json-out) json_out="${2:?$usage}"; shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
mr="${args[0]:?$usage}"
repo="${args[1]:-.}"
mr="${mr#!}"; mr="${mr#\#}"
[[ "$mr" =~ ^[0-9]+$ ]] || { echo "MR must be a number, got: $mr"; exit 1; }

if [ "$(gl_os)" = windows ]; then
  ps_args=(-Mr "$mr" -Repo "$repo")
  [ -n "$json_out" ] && ps_args+=(-JsonOut "$json_out")
  exec powershell.exe -NoProfile -File "$(cygpath -w "$here/fetch-mr-discussions.ps1")" "${ps_args[@]}"
fi

command -v jq >/dev/null 2>&1 || { echo "jq not found (brew install jq)"; exit 1; }
gl_origin_parse "$repo"
gl_header_file || { echo "NO_TOKEN: $(gl_no_token_hint read_api)"; exit 3; }
api="$GL_API/merge_requests/$mr"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/mr-disc.XXXXXX")
trap 'rm -rf "$tmp" "$GL_HEADER_FILE"' EXIT

get() {  # url outfile [headerfile]; fails with FETCH_FAILED on transport error or non-200
  local code
  code=$(curl -sS --max-time 30 -o "$2" ${3:+-D "$3"} -w '%{http_code}' -H @"$GL_HEADER_FILE" "$1") \
    || { echo "FETCH_FAILED: $1"; exit 1; }
  [ "$code" = 200 ] || { echo "FETCH_FAILED: HTTP $code: $(head -c 300 "$2")"; exit 1; }
}

get "$api" "$tmp/mr.json"
page=1; pages=()
while :; do
  get "$api/discussions?per_page=100&page=$page" "$tmp/d$page.json" "$tmp/h$page"
  pages+=("$tmp/d$page.json")
  next=$(tr -d '\r' <"$tmp/h$page" | awk -F': *' 'tolower($1) == "x-next-page" {print $2}')
  [ -n "$next" ] || break
  page=$next
done
jq -s 'add' "${pages[@]}" >"$tmp/all.json"

jq -r '
  "MR: !\(.iid) \(.title)",
  "URL: \(.web_url)",
  "STATE: \(.state) | \(.source_branch) -> \(.target_branch) | head \(.sha) | author \(.author.username)",
  ((.description // "") | length) as $d
  | "DESCRIPTION: \($d) chars\(if $d == 0 then " (empty)" else "" end)"' "$tmp/mr.json"

jq -r '
  [ .[] | {id, notes: [.notes[] | select(.system | not)]} | select(.notes | length > 0) ]
  | (to_entries[]
     | .key as $i | .value as $d | $d.notes[0] as $f | $f.position as $p
     | "",
       "=== THREAD \($i + 1) [\(if ($f.resolvable | not) then "-" elif $f.resolved then "resolved" else "open" end)] \(
           if $p then "\($p.new_path // $p.old_path):\($p.new_line // $p.old_line)" else "(general)" end
         )  discussion=\($d.id)  commit=\(if $p and $p.head_sha then $p.head_sha[0:9] else "" end)",
       ($d.notes[] | "--- \(.author.username) @ \(.created_at[0:16] | sub("T"; " ")):", (.body | gsub("^\\s+|\\s+$"; "")))),
    "",
    "THREADS: \(length)"' "$tmp/all.json"

if [ -n "$json_out" ]; then cp "$tmp/all.json" "$json_out"; echo "JSON: $json_out"; fi
