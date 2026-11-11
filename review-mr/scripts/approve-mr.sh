#!/usr/bin/env bash
# Add the token's owner as a Reviewer of a GitLab MR (keeping the existing reviewers), then
# approve the MR at the reviewed SHA. GitLab refuses the approval (HTTP 409) when the MR head has
# moved past that SHA, so a later, unreviewed commit is never approved by accident.
# Token: see gitlab-lib.sh (`api` scope); never printed. Needs bash, git, curl and jq.
#
# Usage: approve-mr.sh <mr-number> <reviewed-sha> [repo-dir] [--dry-run]
# Exit:  0 approved / already approved (or dry run) · 3 no token · 4 head moved · 1 error
set -euo pipefail
. "$(dirname "$0")/gitlab-lib.sh"

usage="usage: approve-mr.sh <mr-number> <reviewed-sha> [repo-dir] [--dry-run]"
dry=0; args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=1 ;;
    *) args+=("$1") ;;
  esac
  shift
done
mr="${args[0]:?$usage}"
sha="${args[1]:?$usage}"
repo="${args[2]:-.}"
mr="${mr#!}"; mr="${mr#\#}"
[[ "$mr" =~ ^[0-9]+$ ]] || { echo "MR must be a number, got: $mr"; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Bad SHA: $sha"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found (brew install jq)"; exit 1; }

gl_origin_parse "$repo"
gl_header_file || { echo "NO_TOKEN: $(gl_no_token_hint api)"; exit 3; }
api="$GL_API/merge_requests/$mr"
web="$GL_WEB/-/merge_requests/$mr"

gl_call() {  # <method> <url> [curl args...]; sets BODY and CODE (no subshell, so they stick)
  local resp
  resp=$(curl -sS -w '\n%{http_code}' -X "$1" "$2" -H @"$GL_HEADER_FILE" "${@:3}")
  CODE=${resp##*$'\n'}; BODY=${resp%$'\n'*}
}

gl_call GET "https://$GL_HOST/api/v4/user"; me=$BODY
[ "$CODE" = 200 ] || { echo "USER_FAILED: HTTP $CODE: ${me:0:300}"; exit 1; }
me_id=$(jq -r .id <<<"$me"); me_name=$(jq -r .username <<<"$me")

gl_call GET "$api"; info=$BODY
[ "$CODE" = 200 ] || { echo "MR_FAILED: HTTP $CODE: ${info:0:300}"; exit 1; }
state=$(jq -r .state <<<"$info"); head=$(jq -r .sha <<<"$info")
author=$(jq -r .author.username <<<"$info")

echo "TARGET:   $web"
echo "TITLE:    $(jq -r .title <<<"$info")"
echo "STATE:    $state | author $author | head $head"
echo "ME:       $me_name ($me_id)"
echo "REVIEWED: $sha"
[ "$state" = opened ] || { echo "NOT_OPEN: MR is $state, nothing done"; exit 1; }
[ "$author" != "$me_name" ] || echo "WARNING: you are the MR author; the project may not count self-approval"
[[ "$head" == "$sha"* ]] || { echo "HEAD_MOVED: MR head is $head, reviewed $sha; review the new commits first"; exit 4; }

is_reviewer=$(jq --argjson me "$me_id" "[.reviewers[].id] | index(\$me) != null" <<<"$info")
gl_call GET "$api/approvals"; appr=$BODY
[ "$CODE" = 200 ] || { echo "APPROVALS_FAILED: HTTP $CODE: ${appr:0:300}"; exit 1; }
approved=$(jq --argjson me "$me_id" '[.approved_by[].user.id] | index($me) != null' <<<"$appr")

if [ "$dry" = 1 ]; then
  [ "$is_reviewer" = true ] && echo "DRY_RUN: already a reviewer" || echo "DRY_RUN: would add $me_name as reviewer"
  [ "$approved" = true ] && echo "DRY_RUN: already approved" || echo "DRY_RUN: would approve at $head"
  exit 0
fi

if [ "$is_reviewer" = true ]; then
  echo "REVIEWER: already set"
else
  body=$(jq -c --argjson me "$me_id" '{reviewer_ids: ([.reviewers[].id] + [$me])}' <<<"$info")
  gl_call PUT "$api" -H 'Content-Type: application/json' --data "$body"; out=$BODY
  [ "$CODE" = 200 ] || { echo "REVIEWER_FAILED: HTTP $CODE: ${out:0:300}"; exit 1; }
  echo "REVIEWER: added $me_name"
fi

if [ "$approved" = true ]; then echo "ALREADY_APPROVED: $web"; exit 0; fi
gl_call POST "$api/approve" --data-urlencode "sha=$head"; out=$BODY
case "$CODE" in
  201|200) echo "APPROVED: $web" ;;
  409) echo "HEAD_MOVED: GitLab refused, the MR head changed after $sha"; exit 4 ;;
  *) echo "APPROVE_FAILED: HTTP $CODE: ${out:0:300}"; exit 1 ;;
esac
