# Validation record

## Baseline

| Field | Value |
| --- | --- |
| Package | `@opencode/cli` |
| Version | 2.1.2 |
| Tag | v2.1.2 |
| Commit | a517687fde98a7329ada3ae644a01a9fc6c4e99e |
| npm integrity | `sha512-9mBVQTO3WkKzP300NtHuhmXkHTfR2JwFB0AKRGRw4Lt3SNEwo5V4pzXXrwlpRAHoQmINLPuFPGOmn1kxYZdmMQ==` |

`@opencode/cli@2.1.2` is the current OpenCode distribution line. `opencode-ai@1.19.3`
is the previous generation; the previous plan's transformation table does not apply
to this source layout (no `packages/opencode/src/session/prompt/*.txt` exists).

## Source audit findings

- Model prompts live in `packages/core/src/plugin/system-prompt/` (6 files), plus a
  shared `packages/core/src/session/runner/prompt/system.txt`.
- `anthropic.txt` contains no guardrail text.
- Agent prompts (`explore`, `title`, `summary`) are inline constants in
  `packages/core/src/plugin/agent.ts`.
- Plan mode is defined in `packages/core/src/plugin/plan.ts`.
- Telemetry lives in `packages/util/src/observability{,/otlp}.ts` and
  `packages/app/src/entry.tsx`.
- evil-opencode's 9 `sed` patterns target a path absent from 2.1.2, so its
  guardrail stage would be a no-op on this release.

## Verification performed

### Source

| Check | Result |
| --- | --- |
| `bun script/unguarded/apply.ts 2.1.2` | Applied, verification passed |
| Second application | No changes (idempotent) |
| Partial-state rejection | Throws `partially patched` |
| Missing-anchor rejection | Throws |
| `bun script/unguarded/telemetry.ts` | Applied, verification passed |
| Second telemetry application | No changes |

### Build

| Check | Result |
| --- | --- |
| `packages/util` typecheck | Pass |
| `packages/core` typecheck | Pass |
| `packages/app` typecheck | Pass |
| `packages/desktop` typecheck | Pass |
| Full `bun run check` (34 turbo tasks) | 34/34 pass, lint 0 errors |
| `test/unguarded/` | 15 pass, 0 fail |
| Linux x64 build | Success, reports `v2.1.2` |

### Telemetry egress (decisive)

Harness: local Bun server bound to 127.0.0.1, `OTEL_EXPORTER_OTLP_ENDPOINT` set,
binary invoked with `--version` and `debug paths`, then collector inspected.

| Binary | Collector hits |
| --- | --- |
| Stock `@opencode/cli-linux-x64@2.1.2` | `["/v1/logs","/v1/logs","/v1/traces"]` |
| This derivative (local build) | `[]` |
| This derivative (downloaded release) | `[]` |

The stock control proves the harness detects real egress.

### Artifact

| Check | Result |
| --- | --- |
| Release `v2.1.2-unguarded.1` | Published |
| `sha256sum -c checksums.sha256` | OK |
| Archive contents | `bin/`, `libexec/`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `BUILD-INFO.json` |
| `opencode-unguarded --version` | `opencode v2.1.2` |
| Banned string scan | All zero |
| `no restrictions` present | 3 occurrences |

### Isolation

Installed side-by-side as `opencode-unguarded` while the existing `opencode`
remained at 1.19.3 with unchanged sha256 `29eec08d…`.

| Path | Candidate |
| --- | --- |
| data | `~/.local/share/opencode-unguarded/profile/data/opencode` |
| config | `~/.local/share/opencode-unguarded/profile/config/opencode` |
| state | `~/.local/share/opencode-unguarded/profile/state/opencode` |
| db | `~/.local/share/opencode-unguarded/profile/data/opencode/opencode.db` |

An inherited absolute `OPENCODE_DB` pointing at the production database is
rejected with a non-zero exit.

### Functional

`opencode-unguarded run "What does math.py's add function do?"` in a disposable
repository completed with tool use (Glob, Read) and a correct answer.

## Known limitations

- Only Linux x64 is built.
- Provider-side moderation and model behavior are outside the patch's control.
- Custom agent prompts replace the built-in template, so the injected directive
  does not apply to agents that define their own `system`.
- The binary still contains inert `OtlpLogger` / `/v1/traces` strings pulled in by
  the `effect` package's observability barrel; runtime egress is zero, which is
  the meaningful property.
