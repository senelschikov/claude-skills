---
name: docs-confluence
description: >-
  USE WHEN writing or editing team documentation that lands in Confluence — markdown in a
  repo's docs/ tree (docs-as-code, synced by the mark-confluence CI pipeline), adding docs to
  a repo, renaming/moving doc files, or investigating a sync failure ("doc not in Confluence",
  "empty page", "pipeline docs job red", title/ancestry collisions) — incl. Russian asks
  ("напиши доку", "залей в Confluence"). Also routes standalone (non-repo) pages to the
  Atlassian MCP. Covers the authoring contract (H1 = page title, placement = ancestry),
  the local pre-push gates, and post-merge verification.
---

# docs-confluence — docs-as-code with the mark sync pipeline

Team Confluence docs are markdown in git, synced by CI (`docs/publish-to-confluence` job,
mark-confluence image). The pipeline OWNS the pages it syncs; the failure modes are silent
(empty stubs, dead links, error-image diagrams), so the value is in the gates and the
verification — not in the writing.

## Step 0 — route

| The doc is… | Then |
|---|---|
| Repo-backed: describes a repo/system, belongs in version control | Markdown in the repo's docs tree. NEVER hand-create or hand-edit its page in Confluence — new pages are created by title lookup, existing owned pages are matched by their `git-source-*` identity label; a hand-made same-title page (no label) makes creation collide fatally. |
| Standalone: meeting notes, one-off decision page, no owning repo | Atlassian MCP (`createConfluencePage` / `updateConfluencePage`) directly. Keep it OUT of any synced repo's page subtree so a `:full` reconciliation never considers it. |

## Step 1 — author

Plain markdown, **no mark headers** — the pipeline injects `<!-- Space/Title/Label -->`
itself. Two things decide everything:

- **H1 = the Confluence page title.** Unique per space, case-insensitively, across ALL synced
  repos. Qualify it: "MDP Airflow Runbook", never bare "Runbook".
- **File placement = page ancestry.** Directory nesting maps to the page tree;
  `README.md`/`index.md` is the directory's landing page and its H1 names that tree node.

Full contract (title disambiguation, page-tree mapping, labels/identity, repo CI config,
structure rules): `references/mark-conventions.md`.

**Writing rules** — docs here are working documents, not reports:

- Terse, plain language: short sentences, no filler ("in order to", "it is worth noting"),
  no hedging. Technical terms exact; everything else simple.
- Only what a reader needs to WORK: what exists/was done, how to operate, debug, or extend
  it, and why non-obvious decisions were made. Cut process narration ("first we tried…"),
  self-evident statements, and generic background.
- Structure over prose: tables for enumerable facts, numbered lists for procedures,
  diagrams for structure (`docs-mermaid`), prose only for the why.
- Test per section: if removing it changes nobody's action, remove it.

Mermaid in docs: author and validate diagrams with the `docs-mermaid` skill — see its
`references/renderers.md` for what the Confluence renderer supports.

## Step 2 — local gates (before push)

Run all three that apply; each catches a different failure class and none covers another's:

1. **Mermaid blocks → `mmdc` render** (via the `docs-mermaid` skill loop). This is the ONLY
   syntax gate: a broken diagram sails through mark compile-only as an attached
   "syntax error" image with exit 0 (verified on mark 15.3.0), and GitLab only shows the
   error after merge.
2. **markdownlint — title contract:**
   ```sh
   npx --yes markdownlint-cli2@0 "docs/**/*.md"
   ```
   with the shipped config (`references/markdownlint-cli2.jsonc`, copy to the repo root as
   `.markdownlint-cli2.jsonc`): MD041 (H1 on first line) + MD025 (single H1). Style rules are
   deliberately off. Root-mode docs repos (`DOCS_DIR: "."`, e.g. k8s/docs) keep `.md` files at
   the top level — lint `"**/*.md"` there; `"docs/**/*.md"` matches nothing. No npx → say the
   lint gate was skipped.
3. **mark compile-only — mark's own processing.** Repo files carry no headers, so mark FATALs
   on them directly ("doesn't contain metadata") — prepend a temp header to a copy:
   ```sh
   GATE_DIR=<scratch dir>    # any temp/scratch dir; repeat the block per changed file
   printf '<!-- Space: IT -->\n<!-- Title: Compile Test -->\n\n' > "$GATE_DIR/gate.md"
   cat docs/page.md >> "$GATE_DIR/gate.md"
   docker run --rm -v "$GATE_DIR":/work -w /work --entrypoint mark \
     nexus.advsys.work/devops/ci/mark-confluence:1.5.3 --compile-only -f gate.md
   ```
   Use the image tag currently pinned in `ci/templates:/devops/.gitlab-ci-docs-to-confluence.yml`
   (`1.5.3` as of 2026-07). Needs no Confluence access. Nonzero exit / FATAL output = the sync would crash on this
   file. Note what it does NOT catch: mermaid syntax errors (gate 1's job) and broken
   relative links — those pass through as dead hrefs with exit 0 (verified), and no local
   gate covers them: check `[…](./other.md)` targets by hand.

## Step 3 — merge, then verify

Sync runs on the default branch only. After merge:

1. **CI job**: `docs/publish-to-confluence` in the repo's pipeline (runs when `.md` files
   changed; `allow_failure: true` — a red docs job does NOT block the pipeline, so look at it
   explicitly).
2. **Page**: exists in Confluence with the expected parent chain and the H1 as title.
3. Job green but page empty or missing → `references/failure-classes.md` (symptom → cause →
   fix); the common backfill is one manual run of `docs/publish-to-confluence:full`.

## Boundaries

- Never hand-edit sync-owned pages in Confluence (identified by their `synced-from-git-*`
  label) — the next sync overwrites, and title edits break resolution.
- Never suggest the `:purge` job unless the user explicitly asks to purge; it permanently
  breaks external links and requires `CONFIRM_PURGE=true` by design.
- Scope: pipeline mechanics plus the writing rules above — no style guide beyond them.
