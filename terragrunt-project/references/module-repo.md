# Module repo template: terraform-modules/$NAME/$NAME-$OBJECT

Snapshot of `terraform-modules/temporal/temporal-namespace`. One object per module
call, so one object per state.

```
$NAME-$OBJECT/
├── versions.tf
├── variables.tf
├── main.tf
├── outputs.tf
├── README.md
├── .gitignore
├── .gitlab-ci.yml
├── .terraform-docs.yaml     # optional, README generated from .header.md
└── examples/basic/main.tf   # optional
```

Do **not** commit `.terraform.lock.hcl` in module repos (it belongs to live units).

## versions.tf

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    $NAME = {
      source  = "<namespace>/$NAME"
      version = ">= 1.0.0, < 2.0.0"
    }
  }
}
```

No `provider` block, no `backend` — terragrunt generates both.

## variables.tf

```hcl
# One $OBJECT. Takes exactly one, so a caller that keeps one object per state
# writes its fields directly.

variable "name" {
  description = "$OBJECT name. <provider constraints>."
  type        = string
}

variable "name_prefix" {
  description = "Prefix prepended to the name, for accounts shared between environments."
  type        = string
  default     = ""
}

variable "retention_days" {
  description = "History retention, 1-90 days."
  type        = number
  default     = 30

  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 90
    error_message = "retention_days must be between 1 and 90."
  }
}

variable "secret_value" {
  description = "Secret material, usually read from a sops file by root.hcl."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.secret_value == null || !startswith(trimspace(coalesce(var.secret_value, " ")), "ENC[")
    error_message = "secret_value is sops ciphertext - the file was read without being decrypted."
  }
}

variable "deletion_protection" {
  description = "Refuse to destroy the object. Set false and apply before removing the unit."
  type        = bool
  default     = true
}
```

Rules: every variable has `description` and `type`; enums/ranges/mutual exclusion
are `validation` blocks; secrets are `sensitive`; use `optional()` in object types
instead of loose maps.

## main.tf

```hcl
locals {
  name = "${var.name_prefix}${var.name}"
}

resource "$NAME_$OBJECT" "this" {
  name = local.name
  # ...

  lifecycle {
    prevent_destroy = false # use provider-side deletion protection where it exists
  }
}
```

Resource name is `this`. Child items owned by the object (keys, members, search
attributes) are `for_each` over a map input inside the same module, keyed so a
name only has to be unique within its owner.

## outputs.tf

```hcl
output "id" {
  description = "The $OBJECT ID."
  value       = $NAME_$OBJECT.this.id
}

output "name" {
  description = "The $OBJECT name, with prefix."
  value       = $NAME_$OBJECT.this.name
}
```

Secrets returned by the API (tokens) → `sensitive = true` output; note in README
that they live in state.

## .gitlab-ci.yml

```yaml
---
include:
  project: terraform-modules/gitlab-ci-templates
  ref:     master
  file:    gitlab-ci.yml
```

## .gitignore

```
.terraform/
.terraform.lock.hcl

*.tfstate
*.tfstate.*
crash.log
crash.*.log

*.tfvars
*.tfvars.json
!example.tfvars

override.tf
override.tf.json
*_override.tf
*_override.tf.json

.terraformrc
terraform.rc
tfplan

.idea/
.DS_Store
```

## .terraform-docs.yaml

```yaml
---
formatter: markdown
header-from: .header.md
settings:
  anchor: true
  default: true
  required: true
  sensitive: true
  type: true
  lockfile: false
sort:
  enabled: true
  by: required
output:
  file: README.md
  mode: replace
```

## README.md

````markdown
# $NAME-$OBJECT

One <provider> $OBJECT [and what it owns]. One object per module call, so one
object per state.

```hcl
module "example" {
  source = "git::ssh://git@gitlab.loc/terraform-modules/$NAME/$NAME-$OBJECT.git//.?ref=v1.0.0"

  name = "example"
}
```

## Inputs
Required inputs, defaults, what is validated locally.

## Outputs
`id` — what other objects reference it by. Plus `name`, ...
````

## Release

`terraform fmt -recursive && terraform init -backend=false && terraform validate`,
MR, merge, tag `vX.Y.Z`, then bump `module_query` in the live repo. Breaking input
changes → major version.
