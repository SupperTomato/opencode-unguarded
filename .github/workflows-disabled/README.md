# Disabled inherited workflows

This fork was repurposed from `anomalyco/opencode`. The workflows in this
directory belong to upstream's release, deployment, package-publishing,
issue-triage, and notification pipeline. They are kept for reference but are
not active here.

The active workflows are:

| Workflow | Purpose |
| --- | --- |
| `build-release.yml` | Build, verify, package, and optionally publish the derivative |
| `check.yml` | Validate manifests, patches, tests, packaging scripts, and workflow syntax |
| `discover-upstream.yml` | Report new upstream versions; dispatch a build only for a reviewed manifest |

Re-enabling one of these would publish upstream artifacts, deploy upstream
infrastructure, or act on issues and pull requests on this fork. Move it back to
`.github/workflows/` only after auditing its permissions, secrets, and
destinations for this repository.
