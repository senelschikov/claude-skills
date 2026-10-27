#!/usr/bin/env bash
# Shared helpers for the review-mr scripts: GitLab API base from the repo's origin, and the
# token as a curl header file. Source it; do not run it.
#
# Token: $GITLAB_TOKEN, then $GL_TOKEN, then the Windows *user-level* GITLAB_TOKEN read at call
# time. A session started before the variable was set does not inherit it, and
# `$env:GITLAB_TOKEN = ...` in a terminal only lives in that terminal.
#
# The token goes into a private temp file passed as `curl -H @file`. Process substitution
# (`-H @<(printf ...)`) does not work with Git for Windows' curl (exit 26, cannot read the
# /dev/fd path). The file is created with umask 077 and removed on exit. The token is never
# printed.

gl_origin_parse() {  # sets GL_HOST, GL_PATH, GL_API (project API base), GL_WEB
  local repo="${1:-.}" origin
  origin=$(git -C "$repo" remote get-url origin)
  if [[ "$origin" =~ ^https?://([^/]+)/(.+)$ ]]; then GL_HOST=${BASH_REMATCH[1]}; GL_PATH=${BASH_REMATCH[2]}
  elif [[ "$origin" =~ ^[^@]+@([^:]+):(.+)$ ]]; then GL_HOST=${BASH_REMATCH[1]}; GL_PATH=${BASH_REMATCH[2]}
  else echo "Cannot parse origin: $origin" >&2; return 1; fi
  GL_HOST=${GL_HOST#*@}; GL_PATH=${GL_PATH%.git}
  GL_API="https://$GL_HOST/api/v4/projects/${GL_PATH//\//%2F}"
  GL_WEB="https://$GL_HOST/$GL_PATH"
}

gl_token() {  # prints the token, or nothing
  local t="${GITLAB_TOKEN:-${GL_TOKEN:-}}"
  if [ -z "$t" ] && command -v powershell.exe >/dev/null 2>&1; then
    t=$(powershell.exe -NoProfile -NonInteractive -Command \
      "[Environment]::GetEnvironmentVariable('GITLAB_TOKEN','User')" 2>/dev/null | tr -d '\r\n')
  fi
  printf '%s' "$t"
}

gl_header_file() {  # creates the header file, sets GL_HEADER_FILE; returns 3 when there is no token
  local t
  t=$(gl_token)
  [ -n "$t" ] || return 3
  GL_HEADER_FILE=$( (umask 077; mktemp "${TMPDIR:-/tmp}/gl-hdr.XXXXXX") )
  trap 'rm -f "$GL_HEADER_FILE"' EXIT
  printf 'PRIVATE-TOKEN: %s\n' "$t" > "$GL_HEADER_FILE"
}
