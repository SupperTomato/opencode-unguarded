# OpenCode Unguarded v2.1.2 (revision 6)

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

- Build identity, installation identity, and process-lifetime identity are
  separate and all compiled or recorded locally, never environment-controlled.
- Discovery, reuse, and stopping require the *caller's* installation identity.
  Two installations sharing a profile can no longer adopt or stop each other's
  service; the registration and endpoint agreeing with each other is not proof.
- An inherited installation root is only honored when the running executable
  really lives there, and saved service configuration cannot supply it.
- Live discovery and termination require a verified owner: a 404, an
  unauthenticated response, a mismatched PID, another derivative revision, or
  another installation all refuse instead of signalling anything.
- A provably exited owner's stale registration is cleared without signalling a
  reused PID.
- Uninstall proves the running executable belongs to the installation it removes,
  verifies its recorded hash, binds the service to that installation, aborts if
  the service will not stop, and keeps profile data. A registration it accepts is
  one the client can actually read, so a malformed record cannot skip shutdown.
  Foreign, legacy, and malformed registrations are refusals, not warnings.
- The installer requires a checksum entry for the exact archive, mandatory
  executable and launcher hashes, preflights the command directory and link,
  and rolls back every post-activation failure.
- `--dry-run` writes nothing: no directory, log, lock, migration, or registration
  change, no service is stopped, and a profile that does not exist stays absent.
- Direct `libexec/opencode` execution applies the same profile, inherited-config,
  nested-directory, and database containment as the launcher.
- Patch application verifies real Git commit objects and refuses a synthesized
  HEAD or an archive that cannot prove the full tree.

- Every upstream update route is refused at the shared updater boundary,
  including `--method`, startup checks, and TUI updates.
- The derivative identity is compiled into the binary and cannot be changed by
  environment or configuration.
- Service registrations carry the distribution, revision, and installation;
  neither stock nor another derivative revision is adopted.
- `uninstall` removes only the verified derivative installation and keeps profile
  data.
- `--version` reports `v2.1.2-unguarded.6`.

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
  OTLP collector during a real session against an offline model stub; the
  candidate sends none, and the harness fails if either binary crashes or the
  session cannot complete.
- The extracted release archive is installed into a disposable HOME, verified,
  used for a real session, and uninstalled, including while its service runs.
- The release workflow runs the canonical `bun run check` on the patched source,
  the upstream client lifecycle suites for both clients, and packaged acceptance
  against exactly the packaged bytes.

## Install

```bash
tar xzf opencode-unguarded-linux-x64.tar.gz
cd opencode-unguarded
./install.sh
```

The profile lives at `$XDG_DATA_HOME/opencode-unguarded/profile` and is preserved
across upgrades and uninstall.
