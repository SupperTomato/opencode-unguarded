# OpenCode Unguarded

Derivative of OpenCode with built-in model-prompt guardrails removed and outbound
telemetry integrations disabled at build time.

## Upstream

- Version: 2.1.2
- Commit: a517687fde98a7329ada3ae644a01a9fc6c4e99e

## Changes

- Injects an unrestricted-assistance directive into the GPT, GPT Astra, Kimi, Meta,
  and Trinity model prompts.
- Removes the Trinity soft-refusal and secret-guidance lines.
- Removes Kimi's repeated git-mutation confirmation, outside-directory confirmation,
  and blanket outside-working-directory prohibition.
- Removes Meta's "policy violation" framing and the GPT "ask first" clause for
  destructive commands (the prohibition itself remains).
- Removes OTLP log/trace exporters, AI SDK telemetry wiring, browser Sentry
  initialization, and the Sentry build plugin.

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

CI typechecks the patched packages, runs derivative tests, scans the artifact for
banned strings, and starts the binary against a local OTLP collector that must
record zero requests.
