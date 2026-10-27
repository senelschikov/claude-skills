# mark sync conventions — the authoring contract

How the pipeline turns repo markdown into Confluence pages, and what that means for authors.
Verified against `sync_docs_to_confluence.py` (mark-confluence image 1.5.3, mark v15.3.0).

## The pipeline owns the headers

The sync script builds a temp mirror of the repo and injects
`<!-- Space -->` / `<!-- Title -->` / `<!-- Label -->` headers into every `.md` before mark
runs. **Authors never write mark headers in repo files.** A hand-written header would be
prepended-over, and its presence in git is a red flag in review.

## Titles

- **Title = the file's first H1.** No H1 → the sync can't derive a title: the file gets no
  injected headers and produces no Confluence page — silently skipped, nothing red anywhere.
  Every doc file needs exactly one H1 on the first line (lint rules MD041 + MD025 enforce this).
- **Unique per space, case-insensitively, across ALL repos syncing into that space.**
  Real collision: one repo's "GitOps Architecture" vs another's "gitops Architecture" —
  fatal for the second repo's sync. Qualify titles with the system name:
  "MDP Airflow Runbook", "K8S Secrets", never bare "Runbook"/"Secrets".
- **In-repo duplicates are auto-disambiguated**: files sharing an H1 get the nearest unique
  ancestor directory prepended ("mdp-dev-de-01 - Configuration"). Works only within one
  repo — **cross-repo collisions are not auto-resolved by design**; the sync prints a smart
  hint (which page, where, whose label) and someone renames one side.
- **Renaming an H1 is safe**: pages are matched by their `git-source-*` identity label, not
  title, so a rename updates the existing page in place — page ID and external links survive.

## Structure rules

- Exactly one H1, first line. H2/H3 for structure — Confluence builds the TOC from them.
- One topic per file: file = page. Split rather than grow a mixed-topic page.
- `README.md` (or `index.md`) in a directory IS that directory's landing page, and its H1
  names the corresponding tree node for every child page.

## File placement = page ancestry

Parent chain is computed from the docs-tree structure (`compute_parents`). Examples from a
repo with nested `docs/` dirs (gitops-dev):

```
docs/README.md                            → space root (under CONFLUENCE_ANCESTOR_PAGE if set)
docs/getting-started/README.md            → gitops-dev
docs/getting-started/installation.md      → gitops-dev / Getting Started
environments/docs/README.md               → gitops-dev
environments/mdp-dev-de-01/docs/README.md → gitops-dev / Environments
```

- Subdirectory names become intermediate pages, titled by the subdir's README H1 (fallback:
  the directory name).
- Moving a file (`git mv`) to another directory re-parents the existing page in place
  (image ≥1.5.3) — IDs and links survive. Keep the content similar in the same commit, or
  git reports delete+add instead of a rename and the page is recreated.

## Repo CI config

Include the template and set the space/ancestor:

```yaml
stages: [publish-docs]

variables:
  CONFLUENCE_SPACE_KEY: "IT"
  CONFLUENCE_ANCESTOR_PAGE: "K8S - GitOps"   # optional: nest everything under this page

include:
  - project: 'ci/templates'
    ref: master
    file: '/devops/.gitlab-ci-docs-to-confluence.yml'
```

Two discovery modes:

| Mode | When | Extra config |
|---|---|---|
| Auto-discover (default) | docs live in `docs/` dirs anywhere in the repo | none — job triggers on `**/docs/**/*.md` |
| `DOCS_DIR: "."` | dedicated docs repo, `.md` at the root (e.g. k8s/docs) | override the job rules to `changes: ["**/*.md"]` (template header shows the snippet) |

Real examples: `k8s/docs` (root mode, ancestor "K8S - GitOps"), `mdp/docs` (`docs/` subdir,
ancestor "MDP").

Secrets: `CONFLUENCE_API_TOKEN` is a CI variable — never needed (and never present) locally;
the local gate is compile-only precisely because it needs no Confluence access.

## Labels and identity

Every synced page carries two labels, injected via the generated headers:

- `synced-from-git-<repo>-<project-id>` — which repo's sync owns the page. Guards purge
  (foreign-labeled pages are never touched) and identifies sync-owned pages when you're
  looking at Confluence.
- `git-source-<path-slug>-<hash>` — the source-file identity. This is what makes H1 renames
  and disambiguation flips keep the page ID, and what `:full` uses to delete pages whose
  source `.md` left git.

A page in the synced subtree WITHOUT labels = hand-created → collision waiting to happen;
move it out or let the sync adopt/rename around it (see failure-classes.md).

## Lint config

`markdownlint-cli2.jsonc` next to this file is the copy-able repo config: contract rules only
(MD025 single H1, MD041 first-line H1), everything else off — the pipeline doesn't care about
prose formatting and neither should the gate.
