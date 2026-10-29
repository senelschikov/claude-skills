# Live repo templates

Snapshot of `terraform-iac/temporal`. Replace `$NAME` (repo/provider, e.g. `twilio`),
`$PREFIX` (short var prefix, e.g. `tw`), `$OBJECT` (e.g. `subaccount`).

## root.hcl

```hcl
locals {
  global_vars = yamldecode(file(find_in_parent_folders("global.yaml")))
  env_vars    = yamldecode(file(find_in_parent_folders("env.yaml", "${get_repo_root()}/live/default.yaml")))
  # Cloud repos with projects/regions add, same shape:
  # project_vars = yamldecode(file(find_in_parent_folders("project.yaml", "${get_repo_root()}/live/default.yaml")))
  # region_vars  = yamldecode(file(find_in_parent_folders("region.yaml",  "${get_repo_root()}/live/default.yaml")))

  merged_vars = merge(
    local.global_vars,
    local.env_vars,
  )

  # Per-unit data beside the unit. get_terragrunt_dir() is the *including* unit's
  # directory, so this runs once here instead of in every unit. Branch on the
  # sops marker instead of try(): a failed decryption under try() would fall
  # through to the ciphertext.
  secret_file      = "${get_terragrunt_dir()}/secret_enc.yaml"
  secret_raw       = fileexists(local.secret_file) ? file(local.secret_file) : ""
  secret_encrypted = length(regexall("(?m)^sops:", local.secret_raw)) > 0
  secret_yaml      = local.secret_encrypted ? try(sops_decrypt_file(local.secret_file), "") : local.secret_raw

  gcs_state_bucket          = try(local.env_vars.gcs_state_bucket, local.global_vars.gcs_state_bucket)
  gcp_state_bucket_project  = local.merged_vars.gcp_state_bucket_project
  gcp_state_bucket_location = local.merged_vars.gcp_state_bucket_location

  gcs_key_file       = local.merged_vars.encrypt_gcs_state == true ? find_in_parent_folders("gcs_encryption_key.enc.yaml", "") : ""
  gcs_key_yaml       = local.gcs_key_file == "" ? "" : try(sops_decrypt_file(local.gcs_key_file), "")
  gcs_encryption_key = try(yamldecode(local.gcs_key_yaml).key, null)

  credentials = local.merged_vars.credentials_from_sops == true ? yamldecode(sops_decrypt_file(find_in_parent_folders("credentials.enc.yaml"))) : {
    account_id = get_env("$NAME_ACCOUNT_ID", try(local.merged_vars.account_id, ""))
    api_key    = get_env("$NAME_API_KEY", "")
  }
}

# Prefixed so they can never collide with a module variable from the yaml layers.
generate "credentials" {
  path      = "credentials.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
variable "$PREFIX_account_id" {
  type = string
}

variable "$PREFIX_api_key" {
  type      = string
  sensitive = true
}
EOF
}

# Single provider for every unit. When object types need different providers or
# provider settings, move this into _global/_$OBJECT.hcl (as selectel does).
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "$NAME" {
  account_id = var.$PREFIX_account_id
  api_key    = var.$PREFIX_api_key
}
EOF
}

remote_state {
  backend      = "gcs"
  disable_init = tobool(get_env("TERRAGRUNT_DISABLE_INIT", "false"))
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    bucket         = local.gcs_state_bucket
    project        = local.gcp_state_bucket_project
    location       = local.gcp_state_bucket_location
    prefix         = "iac_$NAME/${path_relative_to_include()}"
    encryption_key = local.gcs_encryption_key
  }
}

terraform {
  extra_arguments "disable_input" {
    commands  = get_terraform_commands_that_need_input()
    arguments = ["-input=false"]
  }

  # https://github.com/hashicorp/terraform/issues/27769
  extra_arguments "ignore_cache_on_init" {
    commands = contains(get_terraform_cli_args(), "-upgrade") ? ["init"] : []
    env_vars = {
      TF_PLUGIN_CACHE_DIR = ""
    }
  }

  extra_arguments "add_signatures_for_other_platforms" {
    commands = contains(get_terraform_cli_args(), "lock") ? ["providers"] : []
    # env_vars, since the argument order of "providers lock" is significant
    env_vars = {
      TF_CLI_ARGS_providers_lock = "-platform=darwin_arm64 -platform=darwin_amd64 -platform=linux_amd64"
      TF_PLUGIN_CACHE_DIR        = ""
    }
  }

  # Keep trying to take the state lock if someone else holds it.
  extra_arguments "retry_lock" {
    commands  = get_terraform_commands_that_need_locking()
    arguments = ["-lock-timeout=2m"]
  }
}

inputs = merge(
  local.global_vars,
  local.env_vars,
  {
    name = basename(get_terragrunt_dir())

    $PREFIX_account_id = local.credentials.account_id
    $PREFIX_api_key    = local.credentials.api_key
  }
)
```

## _global/_$OBJECT.hcl

```hcl
locals {
  global_vars = yamldecode(file(find_in_parent_folders("global.yaml")))

  module_source = replace(local.global_vars.module_source, "{object}", "$OBJECT")
  module_root   = substr(local.module_source, 0, 1) == "." ? "${get_repo_root()}/${local.module_source}" : local.module_source
}

terraform {
  source = "${local.module_root}${local.global_vars.module_query}"
}

# Only when the object really needs another unit's output (prefer names):
# dependency "network" {
#   config_path = "${get_terragrunt_dir()}/../../network"
#
#   mock_outputs_allowed_terraform_commands = ["validate"]
#   mock_outputs = {
#     id = "00000000-0000-0000-0000-000000000000"
#   }
# }
#
# inputs = {
#   network_id = dependency.network.outputs.id
# }
```

## Unit: live/$ENV/$OBJECTS/$OBJECT_NAME/terragrunt.hcl

```hcl
include "root" {
  path = find_in_parent_folders("root.hcl")
  # expose = true   # only when the unit reads include.root.locals.*
}

include "_$OBJECT" {
  path = "${get_repo_root()}/_global/_$OBJECT.hcl"
}

# The name comes from the directory, via root.hcl.
inputs = {
  field_a = "value"
  field_b = 30
}
```

## live/global.yaml

```yaml
---
account_id: "<account id>"

credentials_from_sops: false

gcp_state_bucket_project: terraform-281807
gcp_state_bucket_location: us

encrypt_gcs_state: true

module_source: "git::ssh://git@gitlab.loc/terraform-modules/$NAME/$NAME-{object}.git//."
module_query: "?ref=v1.0.0"
# Local work against sibling checkouts:
# module_source: "../$NAME-{object}"
# module_query: ""
```

## live/default.yaml

```yaml
---
dummy-key: dummy-value
```

## live/$ENV/env.yaml

```yaml
---
env: "prod"
name_prefix: ""

gcs_state_bucket: "terraform_$NAME_state_prod"
```

## .gitignore

```
.idea
.terragrunt-cache
.terraform
.DS_Store
*.tfstate
*.tfstate.backup
```

## .sops.yaml

```yaml
creation_rules:
  - path_regex: live/prod/.*
    gcp_kms: projects/terraform-281807/locations/global/keyRings/tf-sops/cryptoKeys/sops-prod
```

Encrypt in place: `sops -i --encrypt --gcp-kms <key> file_enc.yaml`; edit with
`sops file_enc.yaml`; print with `sops -d`.

## .mise.toml

```toml
# Pins the toolchain locally and in CI (the pipeline image runs mise shims).
[tools]
terragrunt = "1.1.6"
opentofu = "1.13.0"   # or terraform, matching the CI image
```

## Setup snippet for README

```shell
brew install terragrunt terraform sops

# https://terragrunt.gruntwork.io/docs/features/provider-cache-server/
export TG_PROVIDER_CACHE=1
export TG_PROVIDER_CACHE_DIR=$HOME/.tg_provider_cache

export $NAME_API_KEY=<api key>
gcloud auth application-default login      # state bucket
```

## Cloud-provider variant (selectel / gcp)

```
live/$ENV/projects/$PROJECT/
├── project.yaml                       # name_prefix, gcs_state_bucket override, labels
├── common/{project,iam,vpc_networks}/terragrunt.hcl
└── regions/$REGION/
    ├── region.yaml                    # region, zone
    ├── networks/ subnetworks/ firewall/ cloud-routers/
    ├── mks/$CLUSTER/   dbaas/$INSTANCE/
    └── vms/$ROLE/
        ├── resource_vars.yaml         # role-wide server settings
        ├── 01/{terragrunt.hcl, resource_vars.yaml}
        └── 02/...
```

`resource_vars.yaml` beside a unit must be read directly — `find_in_parent_folders`
starts one directory **up** — and merged over the one found above it (role level).
VM hostname = `name_prefix-role-index`, derived from directory names in
`_global/_compute.hcl`. Labels/ssh_keys are merged across all layers with
`merge(try(layer.labels, {}), ...)`.
