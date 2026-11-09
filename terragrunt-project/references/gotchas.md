# Gotchas (learned in iac_temporal / iac_selectel / iac_gcp)

- **`find_in_parent_folders` starts one directory up.** It never sees a file beside
  the unit — read those with `"${get_terragrunt_dir()}/file.yaml"` + `fileexists`.
- **`get_terragrunt_dir()` inside root.hcl / _global includes is the unit's dir**, not
  the include's. That is what makes per-unit derivation in one place possible.
- **`dependency` outputs can't be used in `locals`** — only in `inputs`.
- **`mock_outputs` must cover every key the unit indexes**, or `validate` fails
  (plan/apply don't). Update mocks in the same change.
- **Terragrunt won't take a directory as a dependency** — only a unit. "Depend on all
  namespaces" means listing each one; prefer name-based references and document
  the cold-start apply order instead.
- **Directory rename = destroy + create.** Pin `name` in inputs first, then move.
  For state moves between units, `terragrunt state pull/push` or
  `terraform state mv` with both backends.
- **Module cache is sticky.** After pushing a module change:
  `rm -rf .terragrunt-cache` in the unit, or use `--source ../$NAME-$OBJECT`.
  Push the module before the live change that needs it.
- **Never `try(sops_decrypt_file(f), file(f))`** — a KMS failure silently yields
  ciphertext. Detect `^sops:` and decrypt strictly; validate `ENC[` in the module.
- **API-returned secrets (tokens) land in state.** Keep the bucket encrypted
  (`encrypt_gcs_state: true` + sops CSEK) and access-controlled; never print them in CI.
- **Account-scoped providers** (Temporal Cloud, Twilio, Datadog): an "environment" is a
  name suffix, not a separate tree, unless it's a separate account. Use a provider
  guard (`allowed_account_id`-style) so a wrong key fails plan.
- **Lists of members owned by one resource** (group members) must be declared in one
  unit only; two units claiming the full set evict each other.
- **ForceNew fields on imported objects** (`user_data`, etc.) — gate them with a flag
  so imports plan clean.
- **Provider in the module** breaks `generate "provider"` (duplicate provider). Modules
  declare `required_providers` only.
- **Terragrunt 1.x CLI**: `terragrunt run --all plan`, `terragrunt hcl format`,
  `--source` (old `--terragrunt-source`/`run-all`/`hclfmt` are deprecated aliases).
  Pin the version in `.mise.toml`.
- **Lock files**: run `terragrunt providers lock` (root.hcl adds the three platforms)
  so CI on linux and laptops on darwin agree.
