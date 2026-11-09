#!/usr/bin/env bash
# Shared helpers for the review-mr scripts: GitLab API base from the repo's origin, and the
# token as a curl header file. Source it; do not run it.
#
# Token: $GITLAB_TOKEN, then $GL_TOKEN, then an OS store read at call time, so a session started
# before the token was saved still finds it:
#   Windows: the *user-level* GITLAB_TOKEN env var (`$env:GITLAB_TOKEN = ...` in a terminal only
#            lives in that terminal).
#   macOS:   the login Keychain, generic password with service GITLAB_TOKEN.
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

gl_os() {  # windows | macos | linux
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    Darwin) echo macos ;;
    *) echo linux ;;
  esac
}

gl_token() {  # prints the token, or nothing
  local t="${GITLAB_TOKEN:-${GL_TOKEN:-}}"
  if [ -z "$t" ]; then
    case "$(gl_os)" in
      windows) command -v powershell.exe >/dev/null 2>&1 && t=$(powershell.exe -NoProfile -NonInteractive -Command \
                 "[Environment]::GetEnvironmentVariable('GITLAB_TOKEN','User')" 2>/dev/null | tr -d '\r\n') ;;
      macos)   t=$(security find-generic-password -s GITLAB_TOKEN -w 2>/dev/null || true) ;;
    esac
  fi
  printf '%s' "$t"
}

gl_no_token_hint() {  # where to save the token on this OS; $1 = required scope
  case "$(gl_os)" in
    windows) echo "set GITLAB_TOKEN (scope: $1) at Windows user level and retry" ;;
    macos)   echo "save it in the Keychain (scope: $1): security add-generic-password -U -a \"\$USER\" -s GITLAB_TOKEN -w" ;;
    *)       echo "export GITLAB_TOKEN (scope: $1) in the environment Claude Code starts from" ;;
  esac
}

gl_header_file() {  # creates the header file, sets GL_HEADER_FILE; returns 3 when there is no token
  local t
  t=$(gl_token)
  [ -n "$t" ] || return 3
  GL_HEADER_FILE=$( (umask 077; mktemp "${TMPDIR:-/tmp}/gl-hdr.XXXXXX") )
  trap 'rm -f "$GL_HEADER_FILE"' EXIT
  printf 'PRIVATE-TOKEN: %s\n' "$t" > "$GL_HEADER_FILE"
}
