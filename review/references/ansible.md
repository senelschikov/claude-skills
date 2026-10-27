# Ansible roles and scripts deployed to hosts

Read this when the change touches Ansible roles, playbooks or inventory, Jinja templates, systemd
units, cron jobs or shell/Python scripts that Ansible installs on hosts. Each item below is a bug
that reached review at least once.

## Jinja

- Jinja processes backslash escapes inside expression string literals: `'\1'` becomes chr(1), so
  `regex_replace('…(.*)…', '\1')` silently replaces with a control character. Write `'\\1'`, or
  avoid regex (`replace`, slicing). Backslashes in plain template text and in YAML block scalars
  are literal. Only string literals inside `{{ }}` and `{% %}` are processed.
- Render any non-trivial `when:`, `set_fact` or filter chain with real values in a tiny experiment
  before trusting it, especially conditions that gate deletions.
- The template module uses `trim_blocks=True`; a plain `jinja2.Environment()` does not. Render
  with the same settings when testing a template.

## Scope and targeting

- A play runs on **every host of its group**. A destructive task (file removal, cleanup of
  "obsolete" items) needs a guard for hosts that don't use the feature. Otherwise an empty
  default (`{}`) makes everything look obsolete. List the group and check how many hosts define
  the variable.
- `--tags X` skips untagged tasks, including preflight asserts that the rest relies on. Check
  what a documented tag-filtered command actually runs.
- Removal and decommission: when a host stops using a feature (variable emptied, interface
  removed), what is left running? Timers, services, cron jobs and generated files that the role
  no longer manages keep acting on stale input.

## Order and partial failure

- For each destructive task, what happens if the play fails right after it? Example: deleting a
  config before the cron jobs that use it, or deleting cron jobs and then failing on a safety
  check that should have come first. Put the checks before the first destructive step.
- Safety checks on live processes (pid file plus `kill -0`) belong before anything that stops,
  unschedules or deconfigures them.

## systemd and services

- Unit file changes need `register` on the template and a restart when it changed (`state:
  "{{ 'restarted' if x is changed else 'started' }}"`); `daemon_reload` alone does not restart a
  running timer or service.
- Skip `systemd` tasks in check mode (`when: not ansible_check_mode`): on a fresh host the unit
  file was not written, and the task fails.
- Services that write into a shared or group-writable directory: sandbox them like the existing
  units (`ProtectSystem=strict`, `ReadWritePaths=`, `PrivateTmp`, `ProtectHome`,
  `NoNewPrivileges`), and create temp files with `mkstemp` (O_EXCL|O_NOFOLLOW), not a predictable
  name. Check whether the service really needs root, and that the reason given for root is true.

## Debugging and secrets

- `no_log: true` hides the real error (`censored`). When such a task fails, first check the
  usual causes, such as a vault password missing from the run or an undefined secret variable.
  Do not drop `no_log` in a committed change.
- Vaulted vars decrypt only when used, so tasks before the first secret can pass on a run without
  the vault password.

## Scripts installed by a role

- A change to a script that cron runs takes effect on the next cron run, mid-cycle. Check that
  old state files, old file layouts and still-running processes from the previous version are
  handled.
- Defaults duplicated between a script and the role (paths, pid files, state dirs) drift. Render
  them into the config the script reads, and make consumers read the config.
- Counts and summaries a script reports must apply the same filters as the command they describe
  (e.g. an rclone `--filter`), or say clearly what they count.
