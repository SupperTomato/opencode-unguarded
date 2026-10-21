# OpenCode Unguarded v2.1.2 (revision 3)

Derivative of OpenCode with built-in model-prompt guardrails removed and outbound
telemetry integrations disabled at build time.

## Upstream

- Repository: `anomalyco/opencode`
- Package: `@opencode/cli`
- Version: `2.1.2`
- Commit: `a517687fde98a7329ada3ae644a01a9fc6c4e99e`
- Target: Linux x64
- Channel: `unguarded`

## Changes

- Injects an unrestricted-assistance directive into the shared base prompt
  (DeepSeek, Grok, and unmatched models) and into the GPT, GPT Astra, Kimi, Meta,
  and Trinity templates.
- Removes the Trinity soft-refusal and secret-guidance lines.
- Removes Kimi's repeated git-mutation confirmation, outside-directory
  confirmation, and blanket outside-working-directory prohibition.
- Removes Meta's "policy violation" framing and the GPT "ask first" clause for
  destructive commands (the prohibition itself remains).
- Removes OTLP log/trace exporters, browser Sentry initialization, the desktop
  Sentry startup, and the Sentry build plugin.

## Lifecycle changes

- Every upstream update route is refused at the shared updater boundary,
  including `--method`, startup checks, and TUI updates.
- The derivative identity is compiled into the binary and cannot be changed by
  environment or configuration.
- Service registrations carry a derivative marker; a stock registration with the
  same version is not adopted.
- `uninstall` removes only the derivative installation and keeps profile data.
- `--version` reports `v2.1.2-unguarded.3`.

## Preserved

- Runtime permission evaluation (allow/ask/deny).
- Plan and Explore mode read-only restrictions.
- Explicit user cancellation, missing-credential clarification, and factual
  inability handling.
- Protection of unrelated user changes, debug/export credential redaction, and
  provider content-filter error reporting.

## Scope

This changes client-generated instructions only. Provider-side moderation, model
training, and user-installed plugins are unaffected.

## Verification

- The patched source is byte-identical to reviewed outputs pinned by SHA-256 in
  `manifests/2.1.2.json`.
- Any unlisted source change, mixed patch state, symlink escape, or protected-file
  change fails the build.
- Source type checks pass for util, core, cli, app, and desktop.
- Derivative tests and affected upstream suites pass.
- A stock binary built from the same pin is observed sending telemetry to a local
  OTLP collector; the candidate sends none.
- The packaged archive, installer, replacement, rollback, and uninstall paths are
  tested against the built binary.

## Install

```bash
tar xzf opencode-unguarded-linux-x64.tar.gz
cd opencode-unguarded
./install.sh
```

The profile lives at `$XDG_DATA_HOME/opencode-unguarded/profile` and is preserved
across upgrades and uninstall.
