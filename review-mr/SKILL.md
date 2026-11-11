---
name: review-mr
description: Find GitLab merge requests by link (https://gitlab.../-/merge_requests/254), number (!254, "MR 254") or source branch, fetch them with plain git, and review them with the `review` skill. Use whenever the user asks to review, check or give an opinion on an MR / merge request / branch on GitLab, including terse asks like "review mr 254", "glance at !31", "check branch fix/foo" or Russian "посмотри MR". Takes one MR or a batch (a list of links or numbers, e.g. pasted from Slack) and reviews each fully with a summary table. Also triages review comments already on an MR, and posts to GitLab only when explicitly asked ("post it"): a summary comment plus short inline comments on the diff lines, or a thread reply. After a review, "approve" means: add the user as Reviewer and approve at the reviewed SHA. Front end for `review`, which defines the review itself.
---

# Review MR

This skill finds the MR and pins down exactly what is under review. The review itself is done by
the `review` skill. Load it (Skill tool, `review`) once the MR is fetched and follow it from its
step 1 onward. Do not write a lighter review of your own instead.

Given several MRs, follow "Several MRs at once" below. It wraps the steps that follow for each
one.

## 0. Several MRs at once

The input can be MR links, `!N` numbers, bare numbers or branch names, separated by spaces, commas
or newlines, or pasted inside other text (a Slack message, a GitLab MR list). Pull out every MR
reference and drop duplicates (same project, same number). Bare numbers and branches belong to the
current repo. Links name their own project, so one batch can span repos (`k8s-clusters`, `gcp`, …).
Before fetching, say in one line what you parsed, e.g. "4 MRs: k8s-clusters !3214 !3226,
gcp !2006 !2011".

**Fetch everything first.** Run steps 1–2 for every MR before reviewing any of them. The
`fetch-mr.sh` and `fetch-mr-discussions.sh` calls for different MRs are independent, so send them
in parallel. An MR that can't be reviewed must not hold up the others. Record why and keep going:

- `NOT_FOUND`, `NO_LOCAL_CLONE` or an ambiguous repo: collect these into one question at the end,
  not one question per MR.
- Merged or closed: skip the gate review, unless the user asked to review merged ones too.
- `REMOTE_UNREACHABLE`: this hits every MR in that repo, so say it once.

**Review each MR fully.** Every MR gets the whole `review` skill: understand the change, write the
invariants, hunt, verify, report. A batch is never a reason to skim. How to split the work:

- **2–3 MRs:** review them one after another in this context.
- **4 or more:** start one fresh-context subagent per MR, all in one message so they run in
  parallel (Agent tool, `general-purpose`). Each subagent's prompt carries:
  - the repo dir, `!N`, head SHA, merge-base, and the `fetch-mr` / `fetch-mr-discussions` output
    for that MR;
  - an instruction to load the `review` skill and return its full report format;
  - read-only rules: no posting, no approving, no checkout over the working tree;
  - the text of any user instructions that apply to code search, since subagents don't inherit
    them.

  Before reporting, check every critical finding a subagent returns against the cited lines
  yourself. Drop or downgrade any that don't hold up, and say so.

**Report.** Start with one summary table in input order:

| # | MR | Title | Author | Reviewed at | Verdict | Crit / Non-crit | Top issue |
|---|---|---|---|---|---|---|---|

- **MR:** `repo !N` as a link.
- **Reviewed at:** the short SHA.
- **Top issue:** the first critical finding, else the first non-critical one, else "—".
- **Skipped MRs:** add a row with the reason in the Verdict column, e.g. "not found", "merged".

Then each full review in the same order, under a heading `## <n>. <repo> !N — <title>`. Close with
one line about what's next, e.g. "reply `approve` to approve 1, 2, 4; 3 needs changes".

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

It needs only git. It fetches `refs/merge-requests/<N>/head` and prints the commits, diffstat,
merge-base and the source branches that point at the MR head. When an https `origin` has no git
credentials it retries the same project over SSH (`git@host:path.git`, non-interactive) and prints
`SSH_FALLBACK:`; the clone's remote config is not changed. `REMOTE_UNREACHABLE` (exit 1) means
git could not talk to the origin over either (VPN, network or git credentials): say so, don't retry in
a loop, and don't report the MR as missing.

**Then read the MR through the API, if a token exists** (read-only):

```bash
bash ~/.claude/skills/review-mr/scripts/fetch-mr-discussions.sh <N> <repo-dir> [--json-out <scratchpad>/mr<N>.json]
```

The script detects the OS: on macOS and Linux it uses curl + jq, on Windows (Git Bash, no jq) it
runs `fetch-mr-discussions.ps1` through `powershell.exe`. The output is the same either way.

It prints the real target and source branch, state, head SHA, description size, and every review
thread with `file:line`, resolved state, the commit it was written against and its discussion id.
Use the real target branch for the diff. An empty description is worth a non-critical finding.
Read the existing threads before reviewing, so the review does not repeat open threads, and say
which open threads the later commits resolve.

**Without a token the target branch is assumed.** The script then diffs against the repo's
default branch (`master`/`main`). Say this in the review's target line. If the MR is a known
exception (e.g. it targets `dev` or a release branch), re-diff against that branch.

### GitLab token

The API scripts look for `GITLAB_TOKEN` (or `GL_TOKEN`) in the environment, and then in an OS
store read at the moment of the call, so the session does not need a restart: the Windows
**user-level** `GITLAB_TOKEN`, or on macOS the login Keychain (service `GITLAB_TOKEN`). `read_api`
scope is enough to read, posting needs `api`. If it is missing (exit 3, the `NO_TOKEN` line names
the OS-specific fix), tell the user to run the command in their own terminal, not via `!` in the
chat, because that would put the token in the transcript.

macOS (prompts for the token, so it never lands in shell history):

```bash
security add-generic-password -U -a "$USER" -s GITLAB_TOKEN -w
```

Windows PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('GITLAB_TOKEN', '<token>', 'User')
# or, if they already did $env:GITLAB_TOKEN = '...' in that window:
[Environment]::SetEnvironmentVariable('GITLAB_TOKEN', $env:GITLAB_TOKEN, 'User')
```

`$env:GITLAB_TOKEN = …` (or `export` in a terminal) alone lives only in that one terminal and is
invisible here. Never ask for the token in the chat, and never print it.

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
review it), fetch the threads with `fetch-mr-discussions.sh` and check each one against the code
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

A post has two parts, both written for the MR author rather than for the user:

- **The summary**: one general comment with the whole review.
- **Inline comments**: a short version of each finding that has a `path:line`, posted on that
  line of the diff, so the author sees it next to the code.

"post it" means both parts, for the findings the request covers. "post critical" means only the
critical findings, in both parts. "post 2" means finding 2 only. "post summary only" or "no
inline" means the general comment alone.

When asked:

1. Write the summary to a file in the scratchpad:
   - Start with `**Verdict:**`, then `### Critical findings` and `### Non-critical findings`
     (with "None." if empty, or "Not included" when the request left them out), then
     `### Fine as is`.
   - Leave out anything addressed to the user, local paths, scratchpad details and notes about
     how the review was run. Do keep how a finding was confirmed, e.g. "tested with
     statsd-exporter v0.30.0".
   - Keep `path:line` references; GitLab renders them as plain code.
   - End with a short line saying the review was assisted by Claude Code.
2. Write one file per inline comment, each 2–5 lines:
   - Line 1: `**<Critical|Non-critical> · CONFIRMED|SUSPECTED:** <the claim>`.
   - Then the impact in one sentence and the fix. Use a GitLab ```` ```suggestion ```` block when
     the fix replaces the commented line itself.
   - Then `Details in the review summary.` No sign-off line: the summary carries it.
   - Anchor each comment at the line that has to change. For a removed line, that is the old
     side (`--old`, with the line number before the MR). A finding about a missing line goes on
     the closest changed line in the same block.
   - A finding with no `path:line`, or on a file the MR doesn't change, stays only in the
     summary. GitLab accepts inline comments only on files in the diff (`NOT_IN_DIFF`).
3. Dry-run every part first, then post the summary, then the inline comments:
   ```bash
   S=~/.claude/skills/review-mr/scripts
   bash $S/post-mr-note.sh   <N> <summary.md> <repo-dir> --dry-run
   bash $S/post-mr-inline.sh <N> <reviewed-sha> <path> <line> <finding.md> <repo-dir> [--old] --dry-run
   # then the same commands without --dry-run
   ```
   Check the dry runs before posting:
   - `TARGET:` is the repo and MR you reviewed, since MR numbers repeat across sibling repos.
   - The inline dry run's `old line / new line` is the line you meant.

   `post-mr-inline.sh` works out GitLab's diff position from the MR's `diff_refs` and local git,
   so run `fetch-mr.sh` first. It refuses with `HEAD_MOVED` (exit 4) when the MR head is past the
   reviewed SHA. The line numbers would then point at code you didn't review, so re-review
   instead. `POSITION_REJECTED` or `NOT_IN_DIFF` (exit 5) on one finding: put it in the summary,
   say so, and go on with the others.
4. Report the `POSTED:` links: the summary first, then one per inline comment. On `NO_TOKEN`
   (exit 3), follow "GitLab token" above (no restart needed). On `POST_FAILED`, show the HTTP code
   (401/403 means a token or permission problem) and do not retry in a loop.

`post-mr-note.sh --discussion <id>` posts one reply in an existing thread instead. Posting never
approves or merges.

## 4b. Approve when the user texts "approve"

When the user replies "approve" (or "approve it", "одобри", "апрув") after you reviewed an MR in
this conversation, that is the instruction to add them as a Reviewer and approve that MR. Do not
ask again, with two exceptions:

- The review had **critical findings** (verdict "needs changes"): say so in one line and ask
  whether to approve anyway. A second "approve" settles it.
- It is unclear which MR is meant: ask which. A bare "approve" right after a single review means
  that MR, even if others were reviewed earlier in the conversation.

**After a batch** (section 0), the numbers refer to the summary table:

- A bare "approve" (or "approve all") approves every MR in the batch whose verdict was "approve"
  or "approve after X". The "needs changes" MRs are skipped, and the report lists them under one
  "approve these anyway?" line.
- "approve 1 3", "approve !3214 !2006" or "approve all except 2" approve exactly the MRs named.
  Naming a "needs changes" MR explicitly counts as the confirmation, because its verdict was
  shown in the table.
- Run the dry runs for all the chosen MRs first, then the live runs. Report a result table:
  `# · MR · result` (APPROVED / ALREADY_APPROVED / HEAD_MOVED / NOT_OPEN / failed + HTTP code).
  A `HEAD_MOVED` on one MR doesn't stop the others.

The same goes for posting after a batch. "post it" must say which MRs ("post 2", "post all"). Each
MR gets its own comment, and one request covers only the MRs it names.

Run it with the SHA from the review's **Reviewed at** line, dry run first:

```bash
bash ~/.claude/skills/review-mr/scripts/approve-mr.sh <N> <reviewed-sha> <repo-dir> --dry-run
bash ~/.claude/skills/review-mr/scripts/approve-mr.sh <N> <reviewed-sha> <repo-dir>
```

The script finds the token's owner (`GET /user`), adds them to the MR's reviewers while keeping
the existing ones, and approves with `sha=<head>`. Check the dry run's `TARGET:` and `TITLE:` lines
are the MR you reviewed.

- `HEAD_MOVED` (exit 4): commits landed after the review. Do not approve. Review the new commits
  (`<reviewed-sha>..mr/<N>` after re-fetching), report, and wait for a fresh "approve".
- `ALREADY_APPROVED`, `REVIEWER: already set`: fine, report it.
- `NOT_OPEN`: the MR is merged or closed; nothing was done.
- `NO_TOKEN` (exit 3): see "GitLab token" above (`api` scope). `*_FAILED`: show the HTTP code
  (401/403 means a token or permission problem) and do not retry in a loop.

Report `APPROVED:` with the link. One "approve" covers one MR at one SHA. It does not carry over to
later commits or other MRs. Approving never merges, and this skill never merges.

## 5. Otherwise, don't touch the MR

Apart from a requested post or approval, this skill only reads. Do not check out the branch over
the user's working tree, push or merge. The fetched `refs/remotes/mr/<N>` ref is harmless and can
stay.
