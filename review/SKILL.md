---
name: review
description: Correctness review of code changes — find the bugs a careful senior engineer would find by reading, not just check that it compiles or tests pass. Use whenever asked to review, check, look over, sanity-check or give an opinion on a commit, MR/PR, branch or diff: a colleague's commit, an MR into master, or my own branch before opening the MR. ALSO use, without being asked, whenever moving, restoring, cherry-picking, porting or re-applying code between branches or commits: code that "landed intact" is not code that is correct, and a move must not be reported done until the moved code is reviewed or explicitly flagged as unreviewed. When the code was written in this session, the review runs in a fresh-context subagent. Has domain checklists (Airflow DAGs / data pipelines; Ansible / deployed scripts; Prometheus exporters and alert rules).
---

# Review

The goal is to find the bugs a careful senior engineer would find by reading the code, before a
colleague finds them in a follow-up commit. A review that only checks that the code compiles,
imports resolve or tests pass is not a review: tests encode the author's assumptions, so they miss
exactly the bugs the author didn't think of.

## Domain checklists

After step 2, read the reference file for each domain the change touches, and apply it on top of
the general checks in step 3:

| Change touches | Read |
|---|---|
| Airflow DAGs, KPO tasks, ETL / data loading / cost or usage aggregation, sqlglot | `references/airflow-dags.md` |
| Ansible roles/playbooks/inventory, Jinja templates, systemd units, cron, shell scripts deployed to hosts | `references/ansible.md` |
| Prometheus/VictoriaMetrics exporters, textfile collectors, vmalert/Prometheus alert rules, metric labels | `references/prometheus-alerting.md` |

If no file matches, the general checks are the whole checklist. When a review turns up a class of
bug that is specific to a domain and likely to recur, propose adding it to that domain's file (or
a new one) — that is how this skill grows.

## 1. Pin down what is under review

Say the exact target in one line before reading anything, including the commit SHA it is
reviewed at. A verdict holds for that SHA only: any later commit voids it until that commit is
reviewed too. Testing a later commit is not reviewing it.

**Reviewing code you wrote yourself.** If the code under review was written or edited in this
session (by you, or by an agent you directed), do not review it in context: you will read it the
way you meant it and miss what you never thought of. Hand the review to a fresh-context subagent
that gets only the diff, the ticket or MR description, any existing review comments and the repo,
with this skill's steps and report format, and the instruction not to modify anything. Then check
its findings yourself before reporting them. If that is impossible, label the result
"self-review, not independent" in the verdict line. Also, anything you noticed while writing the
code and set aside as a "known limitation" belongs in the findings. Do not leave it out.

- **Commit**: `git show --stat <sha>`, then the full diff. Also read the parent version of each
  touched file — a diff hides the surrounding logic the change depends on.
- **Branch / own diff before MR**: `git diff <base>...HEAD` (three dots — only this branch's
  work). If the branch has merged an integration branch (e.g. `dev`), the diff is polluted with
  other people's work; separate the branch's own commits (`git log <base>..HEAD --no-merges`) and
  review only those.
- **Moved / restored / cherry-picked code**: against the target branch the diff is the *whole
  file*, so review the whole file as new code. Also check that you moved the newest version that
  exists anywhere (`git log --all -- <path>`), and what the target already has (deps, versions,
  config) so nothing is double-applied or downgraded.

## 2. Read for understanding first

Read every changed line and enough of its callers and callees to state, in plain words, what the
code is supposed to do. Then write down its invariants before hunting bugs — e.g. "the parts sum to
the bill", "re-running the same day replaces its rows", "every table a query reads gets a share of
its CPU", "a retry never sends the email twice". Most real bugs are an invariant the code silently
breaks, and you can only see that once the invariant is written down.

## 3. Hunt — general checks

**Arithmetic and aggregation**
- Conservation: do the parts still sum to the total? Is anything added to both a part and the
  total (double count), or moved without being subtracted from its source?
- Division by zero and empty inputs. Units and scale (ns vs s, bytes vs GiB, per-day vs
  per-hour). `max(0, …)`-style clamps that hide a negative which is really a bug.

**Parsing, strings and identifiers**
- `split`/`partition` vs `rpartition`; qualified vs bare names; case folding applied on one side of
  a comparison only; `None` vs empty string.
- Library behaviour you are relying on: verify it with a tiny experiment instead of trusting
  memory — library traps are where confident reviews go wrong.

**State, caches and keys**
- Does a cache key cover everything that changes the cached value (code/parser version, context,
  config)? Can a stale entry bring back old behaviour after a fix?
- Do two different things collide on one key?
- Retries and partial failure: what does a re-run after a crash halfway leave behind?

**Error handling and silent behaviour changes**
- An exception or skip turned into a warning (or the reverse): which failure is now invisible?
  A green run that did nothing is worse than a red one.
- A "fix" commit that also changes semantics. Name the semantic change explicitly.
- Broad `except`, swallowed errors, defaults that hide missing config.

**Inputs you don't control**
- Filters in queries, API responses, file formats: what do they exclude, and where does that
  volume go? What happens with 0, 1, N and very large inputs?

**What the consumer actually receives**
- When the code emits something another system consumes (metrics and their labels, logs, files,
  API payloads, rendered templates), check it against what that system really holds or produces,
  with one real query or sample. Do not check it against what the code writes. Scrapers relabel,
  templating engines unescape, collectors rename. A synthetic test sees none of this.
- For anything with a schedule or a time window, replay it against real history where possible
  ("would this have fired, or done the wrong thing, on a normal day?").

**Deployment and operations**
Walk these explicitly for code that runs on hosts or is deployed by automation:
- first deploy, with no state yet; re-run; a run failing halfway; partial or tag-filtered runs
  and dry/check mode;
- every host or target the automation reaches, not just the ones the author had in mind;
- the transition between versions: old state with new code, and a deploy in the middle of a
  running cycle;
- removal and decommission: what keeps running, alerting or holding resources once the input
  disappears;
- the manual actions operators will take, especially the ones the code's own alerts and docs
  tell them to take;
- privileges, file ownership, symlinks, and anything writable by another user.

**Siblings in the repo**
- Find one or two existing components of the same kind in the repo (another role, exporter, rule
  file or DAG) and compare conventions: restart-on-change, check mode, sandboxing, absence
  alerts, naming. A deviation needs a reason.

**Tests**
- For each bug or risky behaviour: is there a test that would fail if it regressed? If not, write
  out the missing test case (input → expected) in the finding.
- Does a test assert the invariant, or just echo the current output? A test that asserts the wrong
  number locks a bug in — say so.

## 4. Verify before claiming

Separate what you **confirmed** (read the code path end to end, or ran an experiment) from what you
**suspect**, and mark every finding as one or the other. When a quick experiment settles a question,
run it — following the project's rules on where checks run. If you can't run it, say the finding is
unverified and give the exact snippet or query that would settle it. Never present a guess as fact,
and never imply coverage you didn't do.

Run the repo's own linters and validators (e.g. ansible-lint, `--syntax-check`, `vmalert -dryRun`,
ruff, shellcheck) where you can. If they could not run, the verdict cannot be a plain "approve".
It must name what is still unchecked, e.g. "approve once ansible-lint and vmalert -dryRun pass".

## 5. Report

Sort every finding into one of two groups. Ask: "if this merges as is, will something go
wrong that someone has to clean up?"

- **Critical** means the change must not merge until it is fixed. Examples: wrong data or
  numbers produced silently, data loss, an outage or a failed deploy/sync, a security hole,
  breaking existing consumers (dashboards, alerts, APIs), or the change not doing what it claims.
  A SUSPECTED finding can still be critical. Say what would confirm it.
- **Non-critical** means it is worth fixing but safe to merge, possibly in a follow-up. Examples:
  incomplete coverage of the stated goal, missing tests, edge cases with no current input,
  misleading comments or names, cleanups.

When unsure, decide by the worst realistic outcome, not by how big the fix is. A one-line fix can
still be critical. The verdict follows from the groups: any critical finding means "needs changes".
If the only findings are non-critical, the verdict is "approve", or "approve after X" if one of
them should land in this MR.

```
**Reviewed at:** <sha> (<independent | self-review, not independent>)
**Verdict:** <approve / approve after X / needs changes> — one sentence why.

### Critical findings (block merge)
1. **<claim>** — `path:line` · CONFIRMED|SUSPECTED
   What breaks: <concrete input/state → wrong output>.
   Fix: <smallest change>. Test: <missing case>.

### Non-critical findings
1. **<claim>** — `path:line` · CONFIRMED|SUSPECTED
   Why it matters: <impact>. Fix: <smallest change>.

<Write "None." under a group that is empty. Do not drop the heading, since an empty critical
group is itself the main result.>

### Fine as is
<things that look odd but are correct, so nobody re-litigates them>

### Not reviewed
<files, paths or aspects you did not read or verify — always present; "nothing" only if true>
```

Keep praise to the verdict line unless the user asks for an opinion — then say what is good and why
as well. Findings beat summaries: a page of "this commit changes X to Y" with no judgement is an
explanation, not a review.

## When moving code

Moving code is where reviews get skipped, because the task feels mechanical. Before reporting a move
as done, either do the steps above on the moved code, or say plainly in the report: "moved, **not
reviewed**" and offer the review. "Imports resolve" and "identical to the source commit" are
statements about the move, not about the code — never let them stand in for a review.
