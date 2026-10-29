#!/usr/bin/env bash
# Fetch a GitLab MR (by number or source branch) from the repo's origin and
# print what is under review: commits, diffstat, base. Needs only git.
#
# Usage: fetch-mr.sh <mr-number|branch|mr-url> [repo-dir]
# An MR URL (https://host/group/project/-/merge_requests/254[/diffs...]) names the project too:
# the clone is looked up as repo-dir itself, then its sibling directories, by origin.
# Exit:  0 found · 2 not found in this repo (or no local clone of the URL's project) · 1 usage/git error
set -euo pipefail
. "$(dirname "$0")/gitlab-lib.sh"

target="${1:?usage: fetch-mr.sh <mr-number|branch|mr-url> [repo-dir]}"
repo="${2:-.}"
target="${target#!}"; target="${target#\#}"   # accept !254 / #254

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
if [[ "$target" =~ ^https?://([^/]+)/(.+)/merge_requests/([0-9]+) ]]; then
  url_host=$(lower "${BASH_REMATCH[1]}"); url_path=$(lower "${BASH_REMATCH[2]%/-}")
  target=${BASH_REMATCH[3]}
  top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null || (cd "$repo" && pwd))
  found=""
  for d in "$top" "$(dirname "$top")"/*/; do
    d=${d%/}
    git -C "$d" rev-parse --git-dir >/dev/null 2>&1 || continue
    gl_origin_parse "$d" 2>/dev/null || continue
    if [ "$(lower "$GL_HOST")" = "$url_host" ] && [ "$(lower "$GL_PATH")" = "$url_path" ]; then found=$d; break; fi
  done
  if [ -z "$found" ]; then
    echo "NO_LOCAL_CLONE: $url_host/$url_path (looked in $top and its siblings)"
    echo "CLONE_URL: https://$url_host/$url_path.git"
    exit 2
  fi
  repo=$found
  echo "FROM_URL:    !$target in $url_host/$url_path"
  echo "REPO_DIR:    $repo"
fi
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
