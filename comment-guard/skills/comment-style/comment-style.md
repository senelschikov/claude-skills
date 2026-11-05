# Comments and change text: one fact, one home

Governs code comments (Terraform, YAML, scripts), in-file headers, commit messages and MR descriptions, whether a person or an LLM writes them.

Master test for every sentence: **can the reader regenerate it from the code in this file, `git log`/`blame`, `terraform plan`, the module `description`/README, provider docs or memory?** Yes: delete it or replace it with a pointer. A fact has exactly one home; every other place links to it, nothing restates it.

## Placement table

| Fact | Home | Test that puts it there |
|---|---|---|
| Why this value or shape is what it is; invariant the code cannot express; how to choose the value | code comment | Replace the literal on the line with another valid one: the sentence stays true and still needed |
| Trap for the next editor ("X does NOT do Y", "change this, also change that", deliberate absence) | code comment | A reader who did not know it would "fix" the code |
| Measurement behind a request, limit or size | code comment, one line | The number is the only evidence a re-sizer has; the named exception to the rot rule. Date only when `blame` of that line would not give it (a value copied from elsewhere) |
| What this file owns and what deliberately lives elsewhere | in-file header | Would not change if the file were rewritten from scratch tomorrow |
| Problem, why this way, precondition verified before the change | commit body | `git log` is where the next reader looks for it |
| Rejected alternative | commit body; README, docs or memory when the constraint reaches beyond this repository (a permission set, a shared policy), the commit then carries the pointer | Must survive the file that mentioned it |
| Fact still true after a change deletes the file that held it (a procedure, a rejected alternative) | body of the deleting commit, or README when it spans repos | An MR must never point at a header the same MR deletes; `git log -p -- <deleted path>` is not a home |
| Provenance (who, when, which MR or command produced a value); version snapshot (what a set or tag resolved to, build diffs, "was X") | commit body; CHANGELOG where the repo mandates one | `git log -p`/`blame` answers it; it becomes false at the next ordinary bump |
| Expected plan, one-time merge or apply order, migration steps, live checks done, rollback | MR description | Consumed once, at review and merge time |
| Ordering that recurs on every change of this kind ("sync static first", "bump module before consumer") | README or docs | The next MR needs it again |
| What a module input or output does, its default, blast radius, N/N+1 rules | module `description` (terraform-docs copies it into README) | A consumer file would be repeating the module |
| Decision spanning more than one file or module | README or docs | A one-line pointer in the file suffices |
| Rule the LLM got wrong twice; convention that differs from tool defaults | CLAUDE.md or path-scoped `.claude/rules` | Deleting the line would cause a repeat mistake; nothing derivable from code |
| Open question, deferred work, TODO without an owner, DoD | ticket | In code only as `# TODO(DOI-x): <one line>` |

Inside a module: the home of an input's contract is its `description`; the home of a mechanism is one README section; README "Notes" hold only adoption gotchas; the CHANGELOG entry states the delta and links the README section, it does not restate the mechanism.

## Code comments. Budget: 2 lines per fact, at most two facts per comment

A mechanism the code hides (a graph edge, a cidrsubnet ladder, a byte contract, a perpetual-diff fix) may take 4 lines. Budgets are per fact, not per block. Every sentence must pass all six tests:

1. **Derivable?** Uses only the names and values on the lines below to say what they do, or a first-time reader could write it from this file alone: delete.
2. **Said once?** The same fact is in the module `description`, `error_message`, README, CHANGELOG, or another comment in the repo or in this change set: keep one line at the edit site (the line a consumer will change next), pointer (`# see var.addon_set`) or delete elsewhere. A consumer file may restate ONE clause of a module input description as that line.
3. **Tooling says it?** Describes what a `check`, `validation`, precondition or CI job emits when it fires: delete when the check fires on every plan; one line when it fires only on a rare path (an upgrade step, a create).
4. **Rots?** Contains a date, a semver or build string, a SHA, `!NNN`, or "as of / currently / now / since 0.x / was": commit body. Exceptions: the measurement one-liner, and a bare `(!665)` or `(DOI-x)` that IS the pointer.
5. **Survives the next edit?** Replace the literal on the line with any other valid value: sentence no longer true or needed: commit body or MR.
6. **Still true?** Describes a state the code no longer has ("stays off" next to `enabled: true`, "reasoning above" that is not there): delete or fix.

Allowed one-liners that fail test 1 or 4 on purpose: a section label (`# Users`), a format legend above a map, the blast-radius tag legend at the top of `variables.tf`, an origin label for a list of opaque names (`# Bottlerocket test groups (!665)`).

No tombstones (a comment where a line was removed). Nothing on `moved`, `removed` or `import` blocks beyond the trap that stops someone from deleting them early. No "defaults left alone and why" tables: that is the module's variable descriptions.

## In-file header. Budget: consumer file 2 to 3 lines, module file 4

Consumer: what lives in this file versus the module, plus the decision specific to this file. Module: the mechanism plus a pointer to a README section by its title, never by module version ("0.0.2 README" rots, "README, Moving an existing route into extra_routes" does not).

A section preamble (`# --- name ---` followed by prose) is a header-class comment: 4 lines plus the README pointer. A file that exists only to run a procedure (import-then-destroy, temporary moved or removed blocks) may take up to 6: what it holds, the do-not-delete-yet condition, the pointer, the deliberate placement.

Test: does a sentence tell how the file got here ("used to be", "back when", "the moved blocks are gone"), list defaults, or state an expected plan? Commit body or MR.

## Commit message. Budget: subject plus 0 to 5 body lines

Subject `<type>(<scope>): <description>` per `git:conventions`; blank line; body wrapped at 72. A `docs:` or one-line change may have no body.

Each body paragraph answers exactly one of: the problem without the change, why this way, the rejected alternative, the precondition verified before the change. A paragraph that lists files, values or diff hunks: delete. Expected plan and ordering: MR, not here. Exceed 5 lines only for a rejected alternative together with the constraint that forced the choice.

Single-commit MR: write the why once, in the commit; GitLab prefills the description from it, add only items 2 to 7 below. Multi-commit MR: the description is written by hand from the items; each commit body carries its own why and none restates another.

## MR description. Budget: 7 items, about 12 lines wrapped at 72

Title `[DOI-XXXX] <type>: <description>`. Items in this order, each only when it applies:

1. What plus version delta; link the CHANGELOG headings that have a plan effect or a blast radius on this consumer (never a paraphrase); the renovate MR it closes.
2. Plan gate: counts plus resource classes, and what a deviation means ("any destroy = moved key mismatch, do not apply").
3. Order and stacking, stated once: "merge only after !N is APPLIED" where a merged-result pipeline would mix plans.
4. Blast radius in one clause when non-zero (node roll, drain window).
5. Verification the plan cannot show: live checks done, backups, rehearsal result, one line each.
6. Rollback, only when it is not "revert the MR" (state moves, imports, destroys).
7. Links: Jira, predecessor and successor MR.

Exceed only for a procedure with manual steps (state moves, imports, provider removal). Before submitting, and again every time a commit is added to an open MR, re-read against the final diff: every sentence about a change names the hunk that implements it; a sentence that lists names, env vars or version strings the plan diff shows: delete; a sentence promising a follow-up the new commit already does is stale.

## What an LLM reader needs in the file, and what it fetches

In-file, because it cannot be fetched and must interrupt the edit: the invariant the code cannot express, the trap, the deliberate absence, the one reason the literal is what it is, the measurement behind a size.

Fetched at read time, therefore not in-file: provenance (`git log`, `blame`), version snapshots (`git log -p`, CHANGELOG), expected plan (`terraform plan`), what a check emits (run it), the module contract (`variables.tf`, README), procedures and decisions (docs, memory).

Provenance and snapshots rot by construction: the addon_set block below was rewritten twice in four days. Comments cost the same context as code on every future read; a pointer costs one line.

## Examples (before and after, line counts from the audit)

```hcl
## 1. Consumer file, the addon_set block: 7 -> 1 (fails tests 2, 3, 4, 5)
# Immutable addon set: the module never moves addon versions on a bump, only
# this input does. A set takes the builds AWS marks as default for the minor
# on the day it is cut; "1.36-r2" (2026-09-10) differs from "1.36" in ebs-csi
# v1.65.0 and snapshot-controller v8.6.0-eksbuild.7, ... (7 lines)
## after: set contents and cut date are the module CHANGELOG; the lag warning is check.addon_set_lag itself
# The only input that moves addon versions; a module bump never does.
addon_set = "1.36-r2"

## 2. Header of 56-eks-infra-de-02-network.tf: 12 -> 2 (extra_routes ordering mechanics are the module README)
# Network for EKS infra-de-02: the secondary CIDR association stays here, ... (12 lines)
## after
# Network for EKS infra-de-02: the secondary CIDR association stays here (it belongs
# to the VPC owner), everything else is aws-eks-network.
```
```yaml
## 3. values/netbox.yaml worker/housekeeping block: 10 -> 2 (fails test 6: text says "stay off", code has enabled: true)
# Deliberately reduced blast radius against the shared Postgres DB: worker and
# housekeeping stay off ... (10 lines)
## after: only the measurements survive
# Sized from measurements (worker 236-267Mi, RQ forks a work-horse per job; housekeeping
# peaks at 236Mi) so neither runs request-less as on infra-de-01.
```
MR description aws!684 paragraph 2: 13 -> 3 (items 1 and 5; mechanism, counts and output name are the module CHANGELOG that renovate already posted into the repo):
> 0.1.0 (CHANGELOG link): prefix reservations in every pod subnet; one ENI primary already burnt a prefix in zone b, which is why now.
> Expect AvailableIpAddressCount of the pod subnets to drop to ~26 by design; capacity is output pod_capacity.
