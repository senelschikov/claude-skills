#!/usr/bin/env bash
# Post a markdown file as one comment (note) on a GitLab MR of the repo's origin, or as a reply
# in an existing discussion thread (--discussion <id>, from fetch-mr-discussions.ps1).
# Token: see gitlab-lib.sh (`api` scope for posting); never printed. Needs bash, git and curl.
#
# Usage: post-mr-note.sh <mr-number> <body.md> [repo-dir] [--discussion <id>] [--dry-run]
# Exit:  0 posted (or dry run) · 3 no token · 1 error
set -euo pipefail
. "$(dirname "$0")/gitlab-lib.sh"

usage="usage: post-mr-note.sh <mr-number> <body.md> [repo-dir] [--discussion <id>] [--dry-run]"
dry=0; discussion=""; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --discussion) discussion="${2:?$usage}"; shift ;;
    *) args+=("$1") ;;
  esac
  shift
done
mr="${args[0]:?$usage}"
body="${args[1]:?$usage}"
repo="${args[2]:-.}"
mr="${mr#!}"; mr="${mr#\#}"
[[ "$mr" =~ ^[0-9]+$ ]] || { echo "MR must be a number, got: $mr"; exit 1; }
[ -z "$discussion" ] || [[ "$discussion" =~ ^[0-9a-f]+$ ]] || { echo "Bad discussion id: $discussion"; exit 1; }
[ -s "$body" ] || { echo "Body file is empty or missing: $body"; exit 1; }

gl_origin_parse "$repo"
if [ -n "$discussion" ]; then
  api="$GL_API/merge_requests/$mr/discussions/$discussion/notes"
  where="reply in discussion $discussion"
else
  api="$GL_API/merge_requests/$mr/notes"
  where="new comment"
fi
web="$GL_WEB/-/merge_requests/$mr"

echo "TARGET: $web ($where)"
echo "BODY:   $body ($(wc -c <"$body") bytes)"
if [ "$dry" = 1 ]; then echo "DRY_RUN: nothing posted"; exit 0; fi

gl_header_file || { echo "NO_TOKEN: set GITLAB_TOKEN (scope: api) at Windows user level and retry"; exit 3; }

resp=$(curl -sS -w '\n%{http_code}' -X POST "$api" -H @"$GL_HEADER_FILE" --data-urlencode "body@$body")
code=${resp##*$'\n'}; resp=${resp%$'\n'*}
if [ "$code" != 201 ]; then echo "POST_FAILED: HTTP $code: ${resp:0:300}"; exit 1; fi
id=$(printf '%s' "$resp" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
echo "POSTED: $web#note_$id"
