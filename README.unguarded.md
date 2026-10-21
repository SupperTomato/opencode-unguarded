# opencode-unguarded

OpenCode derivative with built-in model-prompt guardrails removed and outbound
telemetry integrations disabled at build time.

Built from audited upstream source, not by patching a released binary.

## Upstream baseline

| Field | Value |
| --- | --- |
| Repository | [anomalyco/opencode](https://github.com/anomalyco/opencode) |
| Package | `@opencode/cli` |
| Version | `2.1.2` |
| Tag | `v2.1.2` |
| Commit | `a517687fde98a7329ada3ae644a01a9fc6c4e99e` |
| Published | 2026-10-21 |

`@opencode/cli` is the current OpenCode distribution line. `opencode-ai` (1.19.3)
is the previous generation and is not the baseline for this repository.

## What this changes

The changes are declared in [`manifests/2.1.2.json`](manifests/2.1.2.json) and
applied by [`script/unguarded/apply.ts`](script/unguarded/apply.ts).

| Prompt | Change |
| --- | --- |
| `gpt.txt` | Injects the unrestricted directive; drops the "ask first" clause while keeping the destructive-command prohibition |
| `gpt-astra.txt` | Injects the unrestricted directive |
| `kimi.txt` | Injects the directive; removes repeated git-mutation confirmation, outside-directory confirmation, and the blanket outside-working-directory prohibition |
| `meta.txt` | Injects the directive; removes the "policy violation" clause |
| `trinity.txt` | Injects the directive; removes the soft-refusal line and the secret-guidance line |
| `anthropic.txt` | Unchanged (upstream contains no guardrail text) |

Telemetry is removed by [`script/unguarded/telemetry.ts`](script/unguarded/telemetry.ts):

- OTLP log and trace exporters become no-ops.
- The observability layer installs only local file/stderr logging.
- Browser Sentry initialization and the Sentry build plugin are removed.
- The desktop Sentry startup becomes a no-op.

## What this deliberately preserves

- Runtime permission evaluation (`allow` / `ask` / `deny`).
- Plan mode and Explore mode read-only restrictions.
- Explicit user cancellation handling.
- Factual inability and missing-credential clarification.
- Protection of unrelated user changes.
- Debug and export credential redaction.
- Provider content-filter error reporting.

Removing an instruction that governs *how* to phrase an inability is not the same as
removing an instruction that *requires* one. The manifest documents each decision.

## Scope limits

This changes client-generated instructions only. It cannot affect model training,
provider-side moderation, gateway policy, or user-installed plugins.

## Verification

`script/unguarded/apply.ts` is fail-closed: every anchor must match its declared
count before any write, a partially patched tree is rejected, and a second run is a
verified no-op.

The build workflow additionally:

1. Typechecks `packages/util`, `packages/core`, and `packages/app`.
2. Runs `test/unguarded/`.
3. Rejects unexpected changed files.
4. Checks the artifact version and scans it for banned strings.
5. Starts the binary against a local OTLP collector and requires **zero** requests.

That last check is the meaningful one. On the same harness, stock upstream 2.1.2
sent `/v1/logs` and `/v1/traces`; this build sends nothing.

## Installation

Download `opencode-unguarded-linux-x64.tar.gz` and `checksums.sha256` from Releases.

```bash
sha256sum -c checksums.sha256
tar xzf opencode-unguarded-linux-x64.tar.gz
install -d ~/.local/opt/opencode-unguarded
cp -r opencode-unguarded/. ~/.local/opt/opencode-unguarded/
~/.local/opt/opencode-unguarded/bin/opencode-unguarded --version
```

The launcher keeps a separate application profile so it does not share sessions,
credentials, configuration, cache, or state with a stock `opencode` install:

```text
$XDG_DATA_HOME/opencode-unguarded/profile/{data,config,cache,state,tmp}
```

Override the location with `OPENCODE_UNGUARDED_PROFILE`. An inherited absolute
`OPENCODE_DB` is rejected rather than silently shared.

## Building

```bash
git clone https://github.com/SupperTomato/opencode-unguarded
cd opencode-unguarded
git checkout unguarded

VERSION=2.1.2
git clone https://github.com/anomalyco/opencode opencode-src
git -C opencode-src checkout "$(jq -r .upstream.commit manifests/$VERSION.json)"

bun install
(cd opencode-src && bun install --frozen-lockfile)

bun script/unguarded/apply.ts "$VERSION" --root opencode-src
bun script/unguarded/telemetry.ts opencode-src

(cd opencode-src/packages/cli && OPENCODE_VERSION="$VERSION" OPENCODE_CHANNEL=latest \
  bun run script/build.ts --target=opencode-linux-x64 --skip-install)
```

## Updating to a new upstream version

1. Audit the new source and record the exact commit.
2. Write `manifests/<version>.json` with exact anchors and reasons.
3. Confirm the fail-closed patcher applies cleanly and tests pass.
4. Run the `build-release` workflow with `publish: true`.

`discover-upstream` reports new versions but will not build a version without a
reviewed manifest.

## License

MIT, inherited from upstream. See [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
