# Exporters, metrics and alert rules (Prometheus / VictoriaMetrics / vmalert)

Read this when the change adds or changes an exporter, a node_exporter textfile collector, metric
names or labels, or vmalert/Prometheus alert rules. The acceptance bar for alert rules is almost
always "fires in the drill, and **a normal day produces no alert**": review against both.

## Labels as stored, not as written

- Scrape configs attach target labels (here: `host`, `stage`, `env`, `region`, `unit`, `service`,
  `job`, `instance`, `severity`). An exporter label with the same name is renamed to
  `exported_<name>` on ingestion, so a rule selecting it matches nothing and the rule never fires.
  Check one real stored series (`/api/v1/query?query=<metric>{host="…"}`) and compare its labels
  with what the rules select.
- Rule labels (`severity`, `channel`) override series labels of the same name in the alert. Make
  sure that is intended.

## Absence and staleness

- An alert on a value goes silent when the series disappears: exporter not installed, textfile
  removed, host renamed. Decide who alerts on absence (`absent_over_time` per expected target,
  rendered from inventory rather than hand-written).
- The textfile collector serves the last file forever, so a dead writer looks healthy. Export a
  last-run timestamp and alert on its age.
- `max_over_time(x[1d])` keeps a vanished series "present" for a day, including through scrape
  outages and label changes. Prefer a plain staleness rule plus an absence rule that is suppressed
  while the target itself is down (`unless on (host) up{job="…"} == 0`).

## Expression mechanics

- Precedence: comparison > `and`/`unless` > `or`. Expressions like `A or B or C unless D` only
  apply `unless` to `C`, so parenthesise.
- Every `and`/`unless`/comparison between two vectors matches on all labels (minus `__name__`)
  unless told otherwise. When one side has an extra label (`stage`/`pipeline_stage`), use
  `ignoring(…)` or `on(…)` and check the result keeps the labels the annotations use.
- A rule without `for:` fires on a single evaluation. Check whether one transient sample can
  trigger it.

## Time windows and state

- Rules keyed on fixed times ("2h after stop") break when durations vary by host or day. Export
  start and end of a run (and whether it is running) and alert on those, not on fixed times.
- Gates that work on a steady state can misfire at the edges: first deploy (no state yet), a
  version transition (old state format), manual operator actions (a manual stop/start), and quiet
  periods (pre-open leads with near-zero traffic). Walk each of them.
- Prefer per-target values that come from config (exported as metrics) over constants in the rule
  when targets genuinely differ, e.g. a quiet period after start.

## Verify against reality

- Parse every rule against the real VictoriaMetrics (`/api/v1/query`); the role also runs
  `vmalert -dryRun`.
- Replay the rule expressions over real history with `query_range` and apply `for:` as a minimum
  run length. A rule that "would not fire" proves nothing if its selector matched no series, so
  check that the inputs exist in the replay window.
- Check the data the rule depends on: e.g. packet rates in the first minutes of a session before
  trusting "no write for 3 min" as a failure signal.

## Delivery

- Check which annotations the destination renders (here the pcaps Slack template shows only
  `summary`). Put the actionable part there.
- Look for the same incident alerted by other systems (other exporters, Loki rules) and either
  pick one owner or document the overlap.
