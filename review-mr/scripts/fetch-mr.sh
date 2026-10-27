#!/usr/bin/env bash
# Fetch a GitLab MR (by number or source branch) from the repo's origin and
# print what is under review: commits, diffstat, base. Needs only git.
#
# Usage: fetch-mr.sh <mr-number|branch> [repo-dir]
# Exit:  0 found · 2 not found in this repo · 1 usage/git error
set -euo pipefail

target="${1:?usage: fetch-mr.sh <mr-number|branch> [repo-dir]}"
repo="${2:-.}"
target="${target#!}"; target="${target#\#}"   # accept !254 / #254
g() { git -C "$repo" "$@"; }

g rev-parse --git-dir >/dev/null
origin=$(g remote get-url origin)
base_branch=$(g symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
if [ -z "$base_branch" ]; then
  for b in master main; do g ls-remote --exit-code --heads origin "$b" >/dev/null 2>&1 && { base_branch=$b; break; }; done
fi

if [[ "$target" =~ ^[0-9]+$ ]]; then
  ref="refs/merge-requests/$target/head"
  local_ref="refs/remotes/mr/$target"
else
  ref="refs/heads/$target"
  local_ref="refs/remotes/origin/$target"
fi

head_sha=$(g ls-remote origin "$ref" 2>/dev/null | cut -f1)
if [ -z "$head_sha" ]; then
  echo "NOT_FOUND: $ref in $origin"
  if [[ "$target" =~ ^[0-9]+$ ]]; then
    last=$(g ls-remote origin 'refs/merge-requests/*/head' 2>/dev/null \
      | sed -n 's#.*refs/merge-requests/\([0-9]*\)/head#\1#p' | sort -n | tail -1)
    echo "HIGHEST_MR_IN_REPO: ${last:-none}"
  fi
  exit 2
fi

g fetch -q origin "+$ref:$local_ref" "+refs/heads/$base_branch:refs/remotes/origin/$base_branch" 2>/dev/null \
  || { echo "FETCH_FAILED: $ref"; exit 1; }
mb=$(g merge-base "refs/remotes/origin/$base_branch" "$local_ref")

echo "REPO:        $origin"
echo "MR_REF:      $ref -> $local_ref"
echo "HEAD:        $head_sha"
echo "ASSUMED_BASE: origin/$base_branch (merge-base $mb)"
echo "SOURCE_BRANCHES:"
g ls-remote --heads origin 2>/dev/null | awk -v s="$head_sha" '$1==s {sub("refs/heads/","  ",$2); print $2}'
if g merge-base --is-ancestor "$local_ref" "refs/remotes/origin/$base_branch"; then
  echo "STATE: already merged into origin/$base_branch"
fi
echo "COMMITS (no merges):"
g log --no-merges --format='  %h %an %ad %s' --date=short "$mb..$local_ref"
merges=$(g log --merges --format='  %h %s' "$mb..$local_ref")
[ -n "$merges" ] && { echo "MERGE_COMMITS (diff may include others' work):"; echo "$merges"; }
echo "DIFFSTAT:"
g diff --stat "$mb" "$local_ref"
echo
echo "Full diff:  git -C '$repo' diff $mb $local_ref"
echo "File at MR: git -C '$repo' show $local_ref:<path>"
