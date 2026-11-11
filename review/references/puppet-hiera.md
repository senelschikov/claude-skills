# Puppet modules and Hiera data

Read this when the change touches Puppet manifests, ERB/EPP templates, files a module deploys
(scripts, configs), or Hiera data (`sysadm-puppet/hiera`, `sysadm-puppet/basic` and siblings).
Each item below came up in a real review.

## Hiera data reaching the class

- Automatic parameter lookup only binds keys named `<class>::<param>` for a class that is in the
  node's `classes` and declares that param. A typo, a missing `classes` entry or a param the
  class doesn't declare (yet) is silently ignored: no error, no effect. Check the key against the
  class signature at the module ref the node runs.
- Module MR + hiera MR pairs: because unknown keys are ignored, either merge order compiles; the
  hiera keys just do nothing until the module lands. Say which order the description wants, and
  check the hiera branch actually adds the class to `classes` where needed.
- A param that only takes effect inside a conditional (e.g. the file is written only when another
  param is set) is a silent no-op on its own. Prefer a `fail()` for the invalid combination, or at
  least document the dependency in the class header.
- Hierarchy and merge: find which layer the key lands in (`data/services/<svc>/<env>.yaml`,
  role, node) and whether `lookup_options` makes it a hash/deep merge. A key set on a broad layer
  reaches every host under it, not just the one in the ticket.

## Generated config must be valid for its consumer

- Render templates with the real values (a tiny `erb` / `epp` run) and read the output; check the
  consumer accepts it (`nginx -t`, `bash -n`, the app's own config check), not just that Puppet
  compiles.
- puppet-nginx 6.0.1 `templates/conf.d/map.epp` writes map keys **unquoted**. A regex key with
  `{` (quantifier like `{2,}`) breaks the nginx config. Quote-free regexes only, or patch the
  template.
- Names built from params can collide. nginx_wrapper rate limits build the zone name as
  `${zone_prefix}${domain}_rate_limits_${rate}_${unit}_${selector}`; two limits with the same
  parts are a duplicate resource and the catalog fails. Fix with a distinct `zone_prefix`, not by
  bending a value (e.g. rate 100 → 101) to dodge the collision.
- Look for other uniqueness-by-name resources the change can duplicate (`file`, `concat::fragment`,
  `nginx::resource::*` titles) across all hosts that include the class.

## Scripts and files the module deploys

- Apply `references/ansible.md` (shell scripts on hosts) to deployed scripts: `bash -n`,
  shellcheck before and after, first run with no state, partial failure.
- Variables a deployed script reads from a file the module writes vs from stdin / CI: check the
  allowlist, so a CI job can't inject a flag meant to be host config.
- Destructive paths (release rotation, cleanup): check what else points into the directory
  (symlinks such as `current`, `canary`, `preprod`) and whether a newly enabled path makes an old
  edge case happen on every run.

## DNS and routing data

- New CNAMEs/records: check what they point at. A record pointing straight at an ingress instead
  of the balancer bypasses it (rate limits, WAF, failover). Compare with sibling records of the
  same service.

## Validators

- `puppet parser validate`, `puppet-lint`, rspec (`pdk test unit`) and, best, a catalog compile
  for one affected node. If none could run (no puppet/pdk locally), the verdict names them:
  "approve once a catalog compile / nginx -t passes".
