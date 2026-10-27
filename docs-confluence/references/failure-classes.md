# Sync failure classes — symptom → cause → fix

Verified against mark-confluence image 1.5.3 (mark v15.3.0). Older-image behaviors are
marked — check the pinned tag in `ci/templates:/devops/.gitlab-ci-docs-to-confluence.yml`
before assuming a fixed bug is back.

| Symptom | Cause | Fix |
|---|---|---|
| Page exists but is EMPTY (stub) | mark creates the page BEFORE compiling; a mid-compile crash (historically: mermaid chromedp panic) leaves the stub | Fix the crash cause, then run `docs/publish-to-confluence:full` manually — it backfills content non-destructively |
| Sync FATAL: ancestry mismatch on a container page | Docs layout changed and an old intermediate page sits under a stale parent | Same-repo pages (our label or unlabeled, inside our ancestor tree): 1.5.3 re-parents them automatically ("ghost adoption") — re-run. Foreign-labeled or outside-tree: the failure hint prints found-vs-expected location — coordinate with the owning team, never move their page yourself |
| Sync FATAL: title conflict | Another repo (or a hand-created page) already holds that title — unique per space CASE-INSENSITIVELY | Read the smart hint (page ID, location, labels). Hand-created page in our subtree: move/delete it in Confluence. Another repo's page: rename one side's H1 with a qualifying prefix. Cross-repo is NOT auto-resolved by design |
| "Confluence requires unique page titles" printed on an unrelated failure | Pre-1.5.2 the hint printed on ANY mark failure | Ignore the hint; read the actual mark error above it |
| Diagram shows a mermaid "syntax error" image in Confluence | Broken mermaid syntax renders the error bomb as a PNG; mark attaches it and exits 0 — no gate fires | Fix the diagram with the `docs-mermaid` mmdc loop (the only hard syntax gate); re-sync |
| mark panic `context deadline exceeded` after ~120 s on a mermaid doc | chromedp render starved: chromium flags missing (image ≤1.5.1) or CPU-starved CI runner | Image ≥1.5.2 fixed the flags. On current images: runner contention — retry, or check the runner's CPU requests. Stub pages left behind → `:full` backfill |
| Link in the published page is dead (`./other.md`) | Broken relative link in source — passes through compile-only AND the sync as a dead href, exit 0 | No automated gate; verify link targets exist when authoring/reviewing |
| Docs job green but the change never synced | `--diff` mode syncs changed files only; historically (≤1.5.2) multi-commit pushes dropped earlier commits, and shallow-clone git failures went silently green | 1.5.3 diffs `CI_COMMIT_BEFORE_SHA..HEAD` and fails loud on git errors. Catch-all: run `:full` |
| Local `mark --compile-only` FATAL "doesn't contain metadata" | Expected — repo files carry no mark headers | Prepend the 2-line Space/Title header to a temp copy (see SKILL.md step 2) |
| Sync fails with 5xx/429 | Confluence outage / rate limit — gets its own failure hint | Retry the job; nothing to fix in the repo |

## Deletion safety (what protects you)

- `:full` deletes only pages whose `git-source-*` label matches a source file removed from
  git — matched by identity label, never by title. Unlabeled or foreign-labeled pages are
  left untouched.
- `:purge` requires `CONFIRM_PURGE=true` on the pipeline run, refuses unqualified labels
  (local runs without `CI_PROJECT_ID`), sweeps unlabeled pages only when `PURGE_UNLABELED=true`
  AND the page was created by the sync service account (hand-written pages never swept),
  and trips a 100-page circuit breaker.
- Confluence DELETE = trash: restorable, and restore keeps page IDs.
