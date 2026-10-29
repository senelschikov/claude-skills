# CI for a live repo

Pipelines live in `terraform-iac/gitlab-ci-templates/$NAME/` (local checkout:
`~/PycharmProjects/gitlab-ci-templates-iac`), like `aws`, `vault`, `k8s-clusters`,
`temporal`. The live repo has **no** `.gitlab-ci.yml`; its Settings → CI/CD →
General pipelines → CI/CD configuration file is
`$NAME/.gitlab-ci.yml@terraform-iac/gitlab-ci-templates`.

Start by copying `temporal/.gitlab-ci.yml` and `temporal/tg-units.sh`.

## Shape

- `workflow:rules` — MR events and the default branch only (no duplicate branch runs).
- Stages: `prepare` (clone the templates repo to get `tg-units.sh`) → `lint`
  (`terragrunt hcl format --check --diff`, `yamllint`) → `plan` → `apply`.
- Variables: `TF_IN_AUTOMATION`, `TG_NON_INTERACTIVE`, `TG_PROVIDER_CACHE=1`,
  `TG_PROVIDER_CACHE_DIR=$CI_PROJECT_DIR/.tg_provider_cache` (cached per ref).
- `before_script`: rewrite `ssh://git@$CI_SERVER_HOST/` to
  `https://gitlab-ci-token:${CI_JOB_TOKEN}@$CI_SERVER_HOST/` so module sources clone
  with the job token; decode `$GCP_STATE` (File var, base64 SA key) into
  `GOOGLE_APPLICATION_CREDENTIALS`.
- **MR**: plan only affected units; expose create/update/delete counts in the MR widget.
- **master**: same plan, then **manual** `apply` of exactly those saved plans; a
  stale plan fails instead of applying.

## tg-units.sh — which units a change touches

| changed file | units planned |
| --- | --- |
| any file inside a unit dir (`terragrunt.hcl`, `*.yaml`, lock file) | that unit |
| other file under `live/` (`env.yaml`, `*.enc.yaml`) | every unit below its directory |
| `root.hcl`, `_global/**` | every unit |
| `*.md`, `scripts/**`, `.gitignore`, `.idea/**` | none |
| unknown/zero base SHA | every unit |

Order units so prerequisites apply first (temporal: namespaces before identities).
**Deleted units are not destroyed**: the plan job goes amber and lists them; run
`destroy` by hand.

## Required setup

- CI/CD variables on the live project: `GCP_STATE` (File), provider API key(s).
- Each module repo: Settings → CI/CD → Job token permissions → allow the live project.
