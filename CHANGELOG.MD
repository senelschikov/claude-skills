# Changelog

Notable changes to the skills and plugins in this repo, newest first.
Add new entries under "Unreleased" and move them under a dated heading when they land on main.

## Unreleased

### Added
- `CHANGELOG.MD` to track changes.
- `review-mr`: batch review of several MRs with a summary table; subagent per MR from 4 up.
- `review-mr`: inline diff comments on post (`post-mr-inline.sh`).
- `review-mr`: "approve" adds the user as Reviewer and approves at the reviewed SHA (`approve-mr.sh`).

### Changed
- `review-mr`: `fetch-mr.sh` falls back to SSH when an https origin has no git credentials.

## 2026-11-05

### Added
- `comment-guard` plugin 0.2.0, with Windows support.

### Changed
- `review`: checks the change against its Jira ticket.

## 2026-10-29

### Added
- `terragrunt-project` skill.

### Changed
- `review-mr`: accepts a GitLab MR link.
- `review-mr`: API scripts support macOS and give a clear error when origin is unreachable.

## 2026-10-27

### Added
- `docs-confluence`, `review` and `review-mr` skills, copied from `~/.claude/skills`.
- `.gitignore` excluding `.idea/`.
