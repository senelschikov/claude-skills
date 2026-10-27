# Airflow DAGs and data pipelines

Read this when the change touches Airflow DAGs, KPO tasks, or code that loads, transforms or
attributes data (ETL, cost/usage aggregation, lake writes). In the de-airflow repo, CLAUDE.md is
authoritative; this file lists what is most worth checking against it.

## Repo rules (de-airflow CLAUDE.md)

- Data windows from `data_interval_start/end`, never `execution_date` / `ds` / `logical_date`.
- `dry_run` Param exists and reaches every side effect: writes, deletes, cache write-backs,
  Slack, dataset events.
- Idempotent per interval: delete/overwrite the interval's slice, then insert. Re-running the same
  day must converge, including a retry that fails halfway.
- No `Variable.get()` or I/O at module top level.
- `catchup=False`, static `start_date`, `max_active_runs=1` for writers, `execution_timeout` on KPO
  tasks, `dagrun_timeout` on the DAG, run-level `on_failure_callback`.
- KPO only through `pod_task()`; pinned images from `src/k8s/images.py`; `schedule=` not
  `schedule_interval` (tests included); `on_finish_action="delete_pod"`.
- Datasets through `src/dags/datasets.py`; alias `extra` values hashable; no events on dry run.
- Same code on test and prod: no env branches, no hardcoded prod paths.
- Renaming a `dag_id` orphans its run history.

## Pipeline traps

- **What the source query filters out.** Read the WHERE clause of every extraction query as part
  of the logic: a status/type filter (`queryType = 'query'`, `state = 'EOF'`, `isQuery = 1`) can
  silently drop the most expensive or most important rows. Ask what each filter excludes and where
  that volume goes — usually it inflates the share of whatever remains.
- **Empty inputs.** What does a day with zero source rows produce: a skip (nothing written, old
  rows left in place, no alert), a failure, or a correct zero row? A green run that wrote nothing
  is the failure mode to look for.
- **Topology assumptions.** Code that takes `ranked[0]`, the first pod, or one volume often assumes
  a single node/replica. Check what happens with N nodes and replication factor > 1.
- **Time bases.** Fixed `86400` / `24h` next to a source that reports actual minutes or a
  partial-day window.
- **Byte vs character limits.** Python slicing counts characters; most SQL `VARCHAR(n)` (StarRocks,
  MySQL in some modes) count bytes. Multi-byte text overflows.

## sqlglot

- `find_all(exp.Table)` also returns CTE names and derived-table aliases.
- `build_scope` / `traverse_scope` only cover the query part: `INSERT/UPDATE/DELETE/CTAS` targets
  drop out, and statements without a query may yield no scope.
- Bare names have no database; resolve them against the session database at read time, not inside
  a cache keyed by statement text.
- Upgrading sqlglot can change `.sql()` output, and with it any digest built from it.

Check the behaviour with a two-line parse on the pinned version rather than from memory.
