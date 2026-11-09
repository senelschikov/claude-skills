---
name: terragrunt-project
description: Scaffold and extend Terragrunt live repos (terraform-iac/*) and their Terraform modules the way iac_temporal, iac_selectel and iac_gcp are built - root.hcl with a yaml variable cascade, _global/_$OBJECT.hcl includes, live/$ENV/... one-unit-per-object tree, GCS state under an iac_$NAME/ prefix, sops secrets, and one separate git repo per terraform module (terraform-modules/$PROVIDER/$PROVIDER-$OBJECT). Use when creating a new terragrunt/IaC repo, adding a new provider (twilio, cloudflare, datadog, ...), adding a unit/object type/environment, writing a new terraform module repo, or reviewing a terragrunt layout.
---

# Terragrunt live repo + per-object module repos

The house layout, distilled from `terraform-iac/temporal` (newest, the reference),
`terraform-iac/selectel` and `terraform-iac/gcp`. A new repo should look like them so
anyone who knows one knows all of them.

## Two kinds of repo

| repo | GitLab path | holds |
| --- | --- | --- |
| **live** | `terraform-iac/$NAME` (dir name `$NAME`, README title `iac_$NAME`) | `root.hcl`, `_global/`, `live/`, README. No `.tf` files. |
| **module**, one per object type | `terraform-modules/$NAME/$NAME-$OBJECT` | one root module managing exactly **one** object |

**One object type = one module repo.** Not a monorepo with `modules/*` (that was
selectel's first iteration; temporal moved to `temporal-namespace`,
`temporal-user`, `temporal-group`, `temporal-service_account`). Each module repo is
versioned, released and CI-checked on its own. Locally, keep them as sibling
checkouts: `~/PycharmProjects/$NAME`, `~/PycharmProjects/$NAME-$OBJECT`, ...

## Live repo layout

```
$NAME/
├── root.hcl                      # yaml cascade, remote_state, credentials, provider vars, extra_arguments, inputs
├── _global/
│   ├── _$OBJECT.hcl              # one per object type: terraform.source (+ provider, shared dependencies)
│   └── ...
├── live/
│   ├── global.yaml               # account-wide: account id, state bucket project/location, module_source/_query, flags
│   ├── default.yaml              # catch-all fallback for find_in_parent_folders (dummy-key: dummy-value)
│   └── $ENV/                     # prod, stage, ...
│       ├── env.yaml              # env, name_prefix, gcs_state_bucket
│       ├── gcs_encryption_key.enc.yaml   # sops, when encrypt_gcs_state: true
│       └── $OBJECT_PLURAL/       # namespaces/, users/, service_accounts/ ...
│           └── $OBJECT_NAME/     # == the object's real name
│               ├── terragrunt.hcl
│               ├── .terraform.lock.hcl   # committed
│               └── *.yaml / *_enc.yaml   # per-unit data read by root.hcl (api_keys.yaml, ca_cert_enc.yaml)
├── scripts/                      # helpers (key generation, imports)
├── .gitignore  .sops.yaml  .mise.toml
└── README.md
```

For cloud providers with projects and regions add the selectel/gcp levels:
`live/$ENV/projects/$PROJECT/{project.yaml, common/$UNIT, regions/$REGION/{region.yaml, $UNIT, vms/$ROLE/$INDEX}}`,
and a `resource_vars.yaml` beside or above a unit.

## Core rules

1. **One unit per object, one state per unit.** `namespaces/orders-prod/`, not one
   `namespaces/` unit with a map. Blast radius = one object; MR plans show only it.
2. **Directory name is the object's name.** `root.hcl` sets
   `name = basename(get_terragrunt_dir())`; units never repeat it. A unit may set
   `name` explicitly to pin it before renaming the directory (rename otherwise =
   destroy + create).
3. **Unit = two includes + flat inputs.** `include "root"` + `include "_$OBJECT"`,
   then the object's own fields directly in `inputs` (no nesting under a map key).
4. **Variables flow by yaml cascade.** `global.yaml < env.yaml [< project.yaml <
   region.yaml < resource_vars.yaml]` merged in `root.hcl` and passed wholesale as
   `inputs`. A yaml key matching a module variable reaches the module on its own;
   others are ignored by terraform. Child `inputs` win per key.
5. **Missing layers fall back** to `live/default.yaml`:
   `find_in_parent_folders("env.yaml", "${get_repo_root()}/live/default.yaml")`.
6. **Module source is one pattern in `global.yaml`** with `{object}` filled in per
   `_global/_$OBJECT.hcl`: `git::ssh://git@gitlab.loc/terraform-modules/$NAME/$NAME-{object}.git//.`
   plus `module_query: "?ref=vX.Y.Z"` (pin a tag; `?ref=master` only while bootstrapping).
   Setting `module_source: "../$NAME-{object}"` + `module_query: ""` uses sibling
   checkouts (relative paths are resolved against the repo root).
7. **State**: GCS backend in the shared iac_gcp buckets (project `terraform-281807`,
   location `us`), bucket from `env.yaml` (`terraform_$NAME_state_$ENV`), prefix
   `iac_$NAME/${path_relative_to_include()}`, optional sops-held CSEK.
8. **Credentials** never in git plaintext: env vars by default, or
   `credentials_from_sops: true` + `credentials.enc.yaml` above the unit (for CI).
   `root.hcl` generates `credentials.tf` with **prefixed** variables
   (`tc_api_key`, `sel_password`, `$PREFIX_api_key`) so they never collide with module
   variables, and a `provider.tf` that consumes them. The provider is generated by
   terragrunt, **not** declared in the module.
9. **Per-unit secrets/data files** (`ca_cert_enc.yaml`, `api_keys.yaml`) are read in
   `root.hcl` via `get_terragrunt_dir()` (which is the *including* unit's dir), so 40
   units don't repeat the code. Decide encrypted vs plain by checking for a `sops:`
   key, never `try(sops_decrypt_file(...))` falling back to raw — that ships
   `ENC[...]` ciphertext to the API.
10. **Prefer names over dependencies.** If a reference can be built from a name
    (`$NAME.$ACCOUNT`, data source lookup by email), do that in the module instead of
    a `dependency` block. When a `dependency` is needed: put it in the `_global`
    include, always with `mock_outputs` + `mock_outputs_allowed_terraform_commands =
    ["validate"]`, and keep the mock keys in sync with what the unit indexes.
11. **`dependency` outputs cannot be read in `locals`** — use them directly in `inputs`.
12. **Commit `.terraform.lock.hcl`** in every unit; generate multi-platform hashes
    (`darwin_arm64`, `darwin_amd64`, `linux_amd64`) via the `extra_arguments` in root.hcl.
13. **Delete-protect anything stateful** (namespaces, DBs, VMs) by default in the
    module; removing such an object is two applies on purpose.
14. **No `.gitlab-ci.yml` in the live repo.** CI comes from
    `terraform-iac/gitlab-ci-templates/$NAME/.gitlab-ci.yml` (set in project Settings
    → CI/CD → CI/CD configuration file), plan on MR, manual apply on master.

## Module repo rules

- Root module at repo root: `versions.tf`, `variables.tf`, `main.tf`, `outputs.tf`,
  `README.md`, `.gitignore`, `.gitlab-ci.yml`, optional `examples/`, `.terraform-docs.yaml`.
- **No `provider` block, no backend** — only `required_providers` with a bounded
  range (`>= 1.6.0, < 2.0.0`) and `required_version = ">= 1.5.0"`.
- Manages **one** object: inputs are that object's fields; `name` + `name_prefix`.
- **Validate locally**: `validation` blocks for enums, ranges, mutually exclusive
  inputs, empty/ciphertext secrets — fail at `validate`, not mid-apply.
- Every variable and output has a `description`; outputs include `id` and `name`.
- `.gitlab-ci.yml` just includes `terraform-modules/gitlab-ci-templates`.
- Release with semver tags; live repos pin them in `module_query`.

## Workflows

**New live repo for provider $NAME** (e.g. twilio):
1. Ask/confirm: object types, environments (is an env a separate account or a name
   suffix?), auth (env vars names), whether state encryption is needed.
2. Create the module repos first (`$NAME-$OBJECT` each) — see
   [references/module-repo.md](references/module-repo.md).
3. Create the live repo from [references/live-repo.md](references/live-repo.md):
   `root.hcl`, `_global/_$OBJECT.hcl` per type, `live/global.yaml`,
   `live/default.yaml`, `live/$ENV/env.yaml`, one sample unit per type, `.gitignore`,
   `.sops.yaml`, `.mise.toml`, README (sections below).
4. Add the CI template in `gitlab-ci-templates/$NAME/` — see
   [references/ci.md](references/ci.md). Grant the live project CI job-token access
   on each module repo.
5. `terragrunt hcl format`, then `terragrunt run --all validate` in `live/`, then plan
   one unit.

**New object type**: module repo `$NAME-$OBJECT` → `_global/_$OBJECT.hcl` →
`live/$ENV/$OBJECTS/` dir → sample unit → update README tables and the CI unit
ordering if it must apply before/after others.

**New object**: `mkdir live/$ENV/$OBJECTS/$OBJECT_NAME`, copy a sibling's
`terragrunt.hcl`, change only the fields, `terragrunt plan` in it, commit the lock file.

**Module change**: push the module (tag) first, bump `module_query`, then
`rm -rf .terragrunt-cache` in affected units and plan. For one-off local testing:
`terragrunt plan --source ../$NAME-$OBJECT`.

**Import existing objects**: write the unit to match reality, run
`terragrunt import '<resource address>' <id>` in the unit, and plan until it shows
no changes; for VMs/servers turn off ForceNew fields first (e.g. selectel's
`cloud_init: false` leaves `user_data` unset).

## README of a live repo

Sections in this order (copy the temporal README tone — explain *why*):
Structure (tree + per-file one-liners) · How a unit is written · How units refer to
each other (table) · How variables reach a module · Setup (brew, `TG_PROVIDER_CACHE`,
credentials) · Secrets (sops commands) · Bootstrap (state bucket, KMS) · Working with
the repo · Adding resources · CI · Things to know (gotchas).

## Gotchas

See [references/gotchas.md](references/gotchas.md) — read before reviewing or
debugging a terragrunt repo.

## Before writing code

Follow the global Neuronet rule: search `neuronet_code_search` (repos
`terraform-iac/temporal`, `terraform-iac/selectel`, `terraform-iac/gcp`,
`terraform-modules/temporal/*`) or the local checkouts in `~/PycharmProjects/` for
the current version of a pattern, since these repos keep evolving — the templates in
`references/` are a snapshot.
