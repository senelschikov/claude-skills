---
name: review-mr
description: Find a GitLab merge request by link (https://gitlab.../-/merge_requests/254), or in the current repo by number (!254, "MR 254", "mr #254") or by source branch, fetch it with plain git, and review its changes with the `review` skill. Use whenever the user asks to review, check, look at or give an opinion on an MR / merge request / branch that lives on GitLab (gitlab.advsys.work), including terse asks like "review mr 254", "glance at !31", "check branch fix/foo" or Russian "посмотри MR". Also use it to read and triage the review comments already on an MR ("check the comments on !254", "evaluate the review"), and to post a finished review or a reply to a thread as a GitLab comment, which it does only when the user explicitly asks ("post it", "comment on the MR"). This is the front end for `review`, which defines how the review itself is done.
---

# Review MR

This skill finds the MR and pins down exactly what is under review. The review itself is done by
the `review` skill. Load it (Skill tool, `review`) once the MR is fetched and follow it from its
step 1 onward. Do not write a lighter review of your own instead.

## 1. Fetch the MR from the current repo

The MR belongs to the repo of the session's working directory, i.e. its `origin` remote. Run the
bundled script with the number, the branch name if that is all the user gave, or the MR link
(`https://<host>/<group>/<project>/-/merge_requests/<N>`, any `/diffs`, `#note_…` suffix is fine):

```bash
bash ~/.claude/skills/review-mr/scripts/fetch-mr.sh <number|branch|mr-url> <repo-dir>
```

A link names the project, so it settles which repo is meant (step 2 does not apply). The script
finds the clone whose `origin` is that project, checking `<repo-dir>` and then its sibling
directories, and prints `REPO_DIR:`. Use that dir and the MR number from the link as `<repo-dir>`
and `<N>` for every later script call. On `NO_LOCAL_CLONE` (exit 2), ask the user where the clone
is, or offer to clone `CLONE_URL` into the scratchpad and review there.

It needs only git (`glab`, `jq` and Python on PATH are not available here). It fetches
`refs/merge-requests/<N>/head` and prints the commits, diffstat, merge-base and the source
branches that point at the MR head.

**Then read the MR through the API, if a token exists** (read-only):

```bash
powershell.exe -NoProfile -File "$(cygpath -w ~/.claude/skills/review-mr/scripts/fetch-mr-discussions.ps1)" -Mr <N> -Repo <repo-dir> [-JsonOut <scratchpad>/mr<N>.json]
```

It prints the real target and source branch, state, head SHA, description size, and every review
thread with `file:line`, resolved state, the commit it was written against and its discussion id.
Use the real target branch for the diff. An empty description is worth a non-critical finding.
Read the existing threads before reviewing, so the review does not repeat open threads, and say
which open threads the later commits resolve.

**Without a token the target branch is assumed.** The script then diffs against the repo's
default branch (`master`/`main`). Say this in the review's target line. If the MR is a known
exception (e.g. it targets `dev` or a release branch), re-diff against that branch.

### GitLab token

Both API scripts look for `GITLAB_TOKEN` (or `GL_TOKEN`) in the environment, and then for the
Windows **user-level** `GITLAB_TOKEN`, read at the moment of the call. The session does not need
a restart. `read_api` scope is enough to read, posting needs `api`. If it is missing (exit 3), tell
the user to run this in their own PowerShell, not via `!` in the chat, because that would put the
token in the transcript:

```powershell
[Environment]::SetEnvironmentVariable('GITLAB_TOKEN', '<token>', 'User')
# or, if they already did $env:GITLAB_TOKEN = '...' in that window:
[Environment]::SetEnvironmentVariable('GITLAB_TOKEN', $env:GITLAB_TOKEN, 'User')
```

`$env:GITLAB_TOKEN = …` alone lives only in that one terminal and is invisible here. Never ask
for the token in the chat, and never print it.

If the user gives both a number and a branch, check that the branch's head SHA appears among the
`SOURCE_BRANCHES` of the MR head. A mismatch means they are talking about two different things,
so ask before going on.

## 2. When the MR is not in the current repo (exit 2)

MR numbers are per project. The same `!254` can exist in a sibling repo, or not at all. A wrong
repo means a confident review of someone else's code. So:

1. Report `NOT_FOUND` and the repo's highest MR number. A number far above that usually points to a
   different project.
2. Check the sibling repos next to this one (e.g. `~/PycharmProjects/mdp-gitops*`, `gitops-*`)
   with `git -C <dir> ls-remote origin refs/merge-requests/<N>/head` (or `refs/heads/<branch>`),
   and list which ones have it.
3. Ask the user which repo they meant, in one line, before reviewing. Exactly one hit is a strong
   hint, not permission. The dev/edu/prod/m2 repos share a layout, so a matching path proves
   nothing. If the user then names the repo or branch, carry on there.

A branch with the same name can exist in several repos at different commits, e.g. a fix
cherry-picked to dev and prod. Mention the other copies. The user may want both reviewed, or need
to know that they differ.

## 3. Hand off to `review`

Load the `review` skill and run it on the `merge-base..mr/<N>` range from step 1:

- Open the target line with: repo, `!N`, source branch, head SHA, assumed base, commit count.
- If `MERGE_COMMITS` were printed, review only the MR's own commits, as the review skill says
  for polluted branches.
- If `STATE: already merged` was printed, say so up front. A review is then input for a
  follow-up, not a gate.
- Read files at the MR revision (`git show mr/<N>:<path>`), not the working tree. The local
  checkout is usually another branch.
- Follow the review skill's report format: reviewed-at SHA, verdict, critical and non-critical
  findings marked CONFIRMED/SUSPECTED, fine as is, not reviewed.
- If the MR's code was written in this session (the user's MR that you implemented), the
  review skill's self-review rule applies: run the review in a fresh-context subagent.
- If the local working tree has changes on top of the MR head, say so. Review the MR head unless
  the user asks for the local state, and then review both against the same SHA.

## 3b. Triage existing review comments

When the user asks to check, evaluate or answer the comments already on an MR (rather than to
review it), fetch the threads with `fetch-mr-discussions.ps1` and check each one against the code
**at the commit the comment was written against** and at the MR head. Verify claims before
agreeing: read the code path, check other repos or master for code the comment cites, and run a
quick experiment where one settles it. Give each thread one verdict:

- **Valid → fix**: a real bug or risk; give the fix you would make.
- **Valid, better fix**: the problem is real but the suggested fix has a side effect or a simpler
  alternative exists; say what and why.
- **Valid, out of scope**: true, but belongs to another ticket or owner; name it.
- **Already addressed**: fixed in a later commit; give the SHA.
- **Disagree**: with evidence (code, data, an experiment), not opinion.
- **Nit**: cheap to take or skip.

Report a table (thread · verdict · one-line reason), then the suggested order of fixes, then draft
replies for the threads you push back on. Drafts stay in the chat. Posting a reply into a thread
(`post-mr-note.sh … --discussion <id>`) follows the same rule as posting a review: only when the
user explicitly asks, one approval per post.

## 4. Post to the MR only when asked

By default the review stays in the chat. Post it to GitLab only when the user explicitly asks in
this conversation, e.g. "post it", "comment on the MR" or "--post". A comment is public to the team
and notifies the author, and it can't really be taken back. Offering to post is fine. Posting
without being asked is not, and one approved post does not cover a later one.

When asked:

1. Write the comment to a file in the scratchpad. It is the review written for the MR author
   rather than for the user:
   - Start with `**Verdict:**`, then `### Critical findings` and `### Non-critical findings`
     (with "None." if empty), then `### Fine as is`.
   - Leave out anything addressed to the user, local paths, scratchpad details and notes about
     how the review was run. Do keep how a finding was confirmed, e.g. "tested with
     statsd-exporter v0.30.0".
   - Keep `path:line` references; GitLab renders them as plain code.
   - End with a short line saying the review was assisted by Claude Code.
2. Dry-run, then post:
   ```bash
   bash ~/.claude/skills/review-mr/scripts/post-mr-note.sh <N> <file> <repo-dir> --dry-run
   bash ~/.claude/skills/review-mr/scripts/post-mr-note.sh <N> <file> <repo-dir>
   ```
   The dry run prints the target MR URL. Check that it is the repo and MR you reviewed, since MR
   numbers repeat across sibling repos.
3. Report the `POSTED:` link. On `NO_TOKEN` (exit 3), follow "GitLab token" above (no restart
   needed). On `POST_FAILED`, show the HTTP code (401/403 means a token or permission problem)
   and do not retry in a loop.

This posts one general comment, or with `--discussion <id>` one reply in an existing thread.
It never posts inline diff comments, approves or merges.

## 5. Otherwise, don't touch the MR

Apart from a requested post, this skill only reads. Do not check out the branch over the user's
working tree, push, approve or merge. The fetched `refs/remotes/mr/<N>` ref is harmless and can
stay.
