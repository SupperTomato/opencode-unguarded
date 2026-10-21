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

---

# Revision .2 — correction record

`v2.1.2-unguarded.1` was experimental and is superseded. The audit reproduced
these defects; each is now covered by a regression test.

| Audit finding | Defect | Fix | Test |
| --- | --- | --- | --- |
| C | `verify`/`fullyApplied` skipped `replace` actions, approving incomplete patches | Require original absence + replacement presence; reject partial state | `manifest.test.ts` state contract |
| C | No manifest validation; absolute/traversal paths accepted | Validate structure, semver, SHA, ids, actions; contain paths to root | `manifest.test.ts` validation |
| C | Unsupported checkout accepted | `verifyUpstreamIdentity` requires matching version | `manifest.test.ts` identity |
| D | DeepSeek/Grok/Claude never received the directive | Inject into shared `system.txt`; Claude inherits via append | `routes.test.ts` |
| E | Verifier passed on empty/nonexistent roots | Require checkout identity and every target file | `telemetry.test.ts` |
| E | Marker comment trusted as proof | Verify behavior; ignore markers | `telemetry.test.ts` |
| E | Dynamic Sentry import undetected | Detect static + dynamic imports and construction | `telemetry.test.ts` |
| E | First pass differed from second (app Vite) | Single-pass determinism | `telemetry.test.ts` |
| F | Inherited config env escaped the profile | Launcher refuses config overrides | manual + launcher |
| F | Relative `..` DB traversal accepted | Launcher rejects `..` and absolute DB | manual |
| F | Service port collided with stock V2 | Distinct channel, port 47499, distinct DB | live coexistence |
| G | Upgrade ran the upstream installer | Refuse with derivative instructions | live `upgrade` |
| H | CI tested the derivative checkout, not the built source | `UNGUARDED_SOURCE_ROOT` + `--check` on `opencode-src` | CI |
| I | Provenance omitted derivative identity | `BUILD-INFO.json` records commit, manifest, run, toolchain | release |

## Verified on the downloaded `v2.1.2-unguarded.2` artifact

| Check | Result |
| --- | --- |
| `sha256sum -c checksums.sha256` | OK |
| `--version` | `opencode v2.1.2` |
| `no restrictions` in binary | 4 occurrences (shared base + 3 templates + …) |
| All banned strings | 0 |
| Database path | `opencode-unguarded.db` |
| OTLP collector with endpoint set | `HITS:[]` |
| Inherited `OPENCODE_CONFIG_DIR` | rejected |
| Absolute `OPENCODE_DB` | rejected |
| `OPENCODE_DB` with `..` | rejected |
| `upgrade` | refuses upstream installer |
| Stock V2 + candidate simultaneously | both listening (49374 and 47499) |
| Functional task | correct answer via Glob + Read |
| Stock `opencode` unchanged | `1.19.3`, sha256 `29eec08d…` |

## Known limitations

- Linux x64 only.
- Provider-side moderation is unaffected.
- Custom agent prompts replace built-in instructions, so the directive does not
  apply to agents that define their own `system`.
- Inert `OtlpLogger` / `/v1/traces` strings remain in the binary from the `effect`
  observability barrel; runtime egress is zero, which is the tested property.
- The candidate does not self-update; updates are manual from this repository.
