# Terragrunt / OpenTofu units and k8s namespaces

Read this when the change touches Terragrunt units or stacks, Terraform/OpenTofu modules, or
k8s-clusters namespaces (k8s-helm / kustomization providers, helm values, raw manifests). Each
item below came up in a real review.

## The plan is the evidence

- Reading the HCL proves the code is consistent, not that it matches what is live. When a finding
  depends on live state, or the MR claims "no changes" / "backfill", run a plan and quote it.
  A critical can turn out to be already applied (gcp !2048).
- Run it without side effects: a `git worktree` at the reviewed SHA in the scratchpad, never a
  checkout over the user's tree; `mise exec -- terragrunt plan -lock=false`. Stacks generate units
  under `.terragrunt-stack/...` (possibly nested); find the unit with `find`.
- OpenTofu state encryption: plan the dependency unit first, so its cache gets `encryption.tf`,
  or the dependent unit cannot read its outputs.
- Read `before_hook` / `after_hook` in `root.hcl` before running anything. In k8s-clusters every
  locking command runs `scripts/switch_k8s_context.sh`, which does `kubectl config use-context`:
  it switches the user's active context globally. Ask first, or save and restore the context.
- Never apply. If the plan could not run, the verdict is "approve once plan shows …", naming the
  unit and the expected result.

## Backfill or change?

- **Backfill** (the code records what was done by hand, with helm or with gcloud): the question
  is "does the code equal live?". Every hand-made object must be in the code or imported; one
  that is live but missing from the code is destroyed on the next apply. The expected plan is
  empty.
- **Change**: look in the plan for destroy/replace (`-/+`, `must be replaced`), force-new
  attributes (names, zone, network, disk type, Cloud SQL `database_version`, node pool machine
  type) and state moves without a `moved` block or `import`.
- Read the MR threads for who applies ("do not apply, X applies himself"). A merged-but-not-yet-
  applied gap is then expected, not a finding. Out-of-band changes (gcloud node pools, `helm
  upgrade`, `kubectl patch`) must be named in the code or README, or the next apply reverts them.

## Variable cascade and merge order

- k8s-clusters merges `live/_global.yaml` < nearest `_cluster.yaml` < `<ns>/_ns.yaml` (falls back
  to `_default.yaml`). Check which layer sets the knob the change relies on (`provider`,
  `render_manifests`, `enable_ns_mgmt_release`, `gcs_state_bucket`).
- Helm `values` list order is **not** precedence: the k8s-helm module loads them via `toset()`,
  i.e. lexically sorted. `"./x.yaml"` sorts before `"${get_repo_root()}/…"`, so the shared file
  wins every conflict. Overrides must be `"${get_terragrunt_dir()}/x.yaml"` or a bare `"x.yaml"`.
  Tell: the plan sets an overridden key to the `_helm_values/…/common.yaml` value.
- Helm merges values files deeply for maps only; lists (`tolerations`, `containers`, `volumes`,
  `env`) are replaced whole by the later file.
- `include` with `merge_strategy = "deep"` merges maps such as `namespace_labels` and `releases`:
  a key the unit "drops" still arrives from the include (e.g. `product: Unknown` labels).
- `null` in helm values deletes a chart default (`limits.cpu: null` in a quota). Check it is
  intended and has a precedent in the repo.
- Terragrunt passes unknown inputs silently. When a module ref changes or a new input appears,
  check the module at that ref declares it.

## Numbers that must agree

- Quota vs workload: max replicas / `maxRunners` × per-pod requests and limits ≤ quota, for every
  key (`requests.cpu`, `requests.memory`, `limits.memory`, `pods`, `secrets` — ARC creates a
  Secret per runner). A comment whose arithmetic no longer matches the value is a finding: the
  next resize will copy the wrong number.
- Pods per node vs node allocatable, not the raw machine size (GKE reserves CPU and memory, plus
  DaemonSets).
- Node pool sizes, sysctls and machine types managed outside the repo are claims: mark findings
  that depend on them SUSPECTED unless you queried them.

## Kubernetes specifics

- NetworkPolicies: default-deny must keep DNS. Pods dial the kube-dns Service ClusterIP, so
  besides the kube-system namespaceSelector an ipBlock `/32` for that IP is needed when private
  ranges are excluded; compare the IP with sibling namespaces on the same cluster. Egress
  `except` lists should cover pod/service/VPC CIDRs and 169.254.0.0/16 (metadata servers).
- ns-mgmt (`helm-system-templates`) brings `allow_web` / `allow_gke_master_subnets` from
  `_helm_app_ns.hcl`; they open ingress. A namespace meant to be isolated needs `mode: custom`
  or equivalent to keep them out.
- Pod Security labels and Kyverno: PSA labels must survive the include merge; a declared
  `runAsUser`/`runAsGroup` must match the image's real user.
- Images pinned by digest; for images built in another repo, note where the build lives.
- SealedSecrets: name and namespace must match the target (strict scope by default); only
  ciphertext is committed; the README command does not echo the secret or put it in argv.
- `releases_manifests` raw manifests: check `computed_fields` for fields controllers mutate
  (annotations, labels), or every plan shows drift.

## Modules and versions

- A module `?ref=` bump means reviewing the module diff between the two refs, not the string.
- Chart versions pinned and consistent with sibling releases of the same chart (e.g. ARC scale
  set chart = controller chart version).
- `.terraform.lock.hcl` changes should match intended provider bumps; say if you didn't read it.

## Siblings

- Compare with one or two units of the same kind on the same cluster or environment (`arc-runners`
  for `arc-ci-runners`, another cluster's `kube-auth`): `_ns.yaml` knobs, labels, policies,
  quotas, hooks. A deviation needs a reason in a comment.
