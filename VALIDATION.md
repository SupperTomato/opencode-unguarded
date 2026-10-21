# Validation record

This file records what revision 3 verified, with the local evidence for each
claim. CI runs the same gates; the workflow run URL is added to the release asset
metadata, not to this file.

## Baseline

| Field | Value |
| --- | --- |
| Package | `@opencode/cli` |
| Version | 2.1.2 |
| Tag | v2.1.2 |
| Commit | a517687fde98a7329ada3ae644a01a9fc6c4e99e |
| npm integrity | `sha512-9mBVQTO3WkKzP300NtHuhmXkHTfR2JwFB0AKRGRw4Lt3SNEwo5V4pzXXrwlpRAHoQmINLPuFPGOmn1kxYZdmMQ==` |
| Derivative revision | 3 |
| Target | linux-x64 |
| Toolchain | Bun 1.4.2, Node 24 |

`@opencode/cli@2.1.2` is the current OpenCode distribution line. `opencode-ai@1.19.3`
is the previous generation; its source layout does not apply here.

## Correction history

| Revision | Outcome |
| --- | --- |
| `.1` | Missed the shared base prompt and some template routes; verifiers accepted incomplete patches. Do not use. |
| `.2` | Added route coverage but left these defects: `--method` reached the upstream installer; startup/TUI paths were unguarded; source identity was version-only; launcher and patch targets followed escaping symlinks; telemetry checks trusted markers; service migration accepted equal versions; uninstall used upstream cleanup; route tests duplicated routing. |

Revision 3 replaces the string-based approach with exact reviewed bytes and adds
behavioral tests for each defect above.

## How to reproduce

```bash
bun install
UNGUARDED_UPSTREAM=/path/to/checkout-at-a517687f bun test ./test/unguarded/
bun script/unguarded/validate.ts --upstream /path/to/checkout-at-a517687f
```

With a built binary:

```bash
bun script/unguarded/validate.ts \
  --upstream /path/to/pristine \
  --binary /path/to/built/opencode \
  --release
```

## Results

### Source identity and patch application

| Check | Evidence |
| --- | --- |
| Manifest schema validated | `test/unguarded/apply.test.ts`, `manifest.test.ts` |
| Pristine fingerprints match the pin | `validate.ts B1`, `apply.test.ts` |
| Pristine input produces reviewed bytes | `validate.ts B2`, `apply.test.ts` |
| Already-patched tree is a no-op | `apply.test.ts` |
| Mixed pristine/final tree rejected | `apply.test.ts` |
| Drift retaining expected strings rejected | `apply.test.ts` |
| Wrong commit, package, or version rejected | `apply.test.ts` |
| Symlinked target or parent rejected | `apply.test.ts` |
| Hard-linked target rejected | `apply.test.ts` |
| Failure leaves every target untouched | `apply.test.ts` |
| Protected file change rejected | `apply.test.ts` |

### Prompt routing and preservation

| Check | Evidence |
| --- | --- |
| Directive exactly once for GPT, Astra, Kimi, Muse, Trinity, Claude, DeepSeek, Grok, unknown | `packages/core/test/plugin/unguarded-routing.test.ts` (production plugin hooks and real renderer) |
| Family-specific removals present | same |
| Custom agent prompt preserved | same |
| Compaction and generate hooks routed | same |
| Tool guidance rendered | same |
| Claude appendix unmodified and unmarked | `manifest.test.ts` |
| Permission, plan, explore files byte-identical | protected fingerprints in `manifests/2.1.2.json`, `validate.ts`, upstream suites |
| Toolchain type checks | `bun run typecheck` (34/34 tasks) |

### Lifecycle

| Check | Evidence |
| --- | --- |
| `upgrade` refuses without spawning | `packages/cli/test/unguarded-updater.test.ts` (`upgrade` with all eight methods) |
| `--method` cannot bypass | same |
| `latest`, `run`, `check`, `apply` refuse or report unavailable | same |
| `removal` not offered | same |
| A stock build still upgrades (control) | same |
| Command-level refusal before method detection | `test/unguarded/lifecycle.test.ts` |
| Registration carries derivative marker | `packages/cli/test/unguarded-service.test.ts` |
| Equal-version stock registration not adopted | same |
| Derivative registration migrates | same |
| Derivative port/filename | same |
| Derivative removal requires installation root and ownership | `lifecycle.test.ts`, `install.test.ts` |

### Launcher and packaging

| Check | Evidence |
| --- | --- |
| Profile inside stock storage rejected | `test/unguarded/launcher.test.ts` |
| Inherited config/home overrides rejected without creating a profile | same |
| Absolute, nested, traversing, symlinked DB rejected | same |
| Symlinked profile storage rejected | same |
| Inherited server attachment rejected | same |
| Canonical XDG paths exported | same |
| Archive checksum, shape, and symlink checks | `test/unguarded/install.test.ts` |
| Embedded revision must match metadata | same |
| Unrelated command link not replaced | same |
| Replacement keeps rollback copy | same |
| Uninstall keeps profile and stock command | same |

### Telemetry

| Check | Evidence |
| --- | --- |
| Exporter-construction markers absent from source | `test/unguarded/telemetry.test.ts` |
| Decoy comments and dynamic imports rejected | same |
| Local logging preserved | same |
| Binary contains no exporter or Sentry wiring | `telemetry.ts --binary`, `validate.ts A4` |
| Stock binary emits telemetry through the harness | `packaging/linux-x64/telemetry-harness.sh` positive control |
| Candidate emits none | same |

Local run of the harness:

```text
candidate hits: []
stock hits: ["/v1/logs","/v1/logs","/v1/traces","/v1/traces","/v1/traces","/v1/logs"]
telemetry harness passed: stock emitted telemetry, candidate emitted none
```

### Runtime smoke

| Check | Evidence |
| --- | --- |
| Built binary reports `v2.1.2-unguarded.3` | local build |
| `debug paths` shows the candidate profile, DB, and state | local run through the installed launcher |
| Stock 2.1.2 and candidate run simultaneously on separate ports | local run, both servers listening |
| Installation and removal against the built binary | local `install.sh` / `uninstall.sh` run |

## Published artifact

| Field | Value |
| --- | --- |
| Release | https://github.com/SupperTomato/opencode-unguarded/releases/tag/v2.1.2-unguarded.3 |
| Release target commit | `caabdd878334a05f699718a3dcdc5cfc69a79855` |
| Build workflow run | https://github.com/SupperTomato/opencode-unguarded/actions/runs/39561462354 |
| Archive SHA-256 | verified with the published `checksums.sha256` |
| Executable SHA-256 | `3bc1332bc20084d366cee41cc733a6b455a86b6fcb12bbdedbc4bf7acdb1c50a` |
| Launcher SHA-256 | `e4a9b5932aaf7f2102b430cce4c6154ae22b761011258bcd0a9c067b53323041` |
| Manifest SHA-256 | `9ac94dea9a03721f120c3ef6cf45514a659ba45bc6567d3ffa99b66ba8753ff8` |
| Toolchain | Bun 1.4.2, Node v24.21.0 |

The downloaded archive was verified against its checksum, extracted, and checked:

- `verify3` byte comparison: the installed executable and launcher match the
  hashes recorded in `BUILD-INFO.json`.
- `validate.ts --release` against the downloaded binary: 6/6 gates pass.
- Telemetry harness against the downloaded binary: candidate `[]`, stock control
  emitted `/v1/logs` and `/v1/traces`.

### Installed acceptance

| Check | Result |
| --- | --- |
| Candidate installed to `~/.local/opt/opencode-unguarded` | installed, previous `.2` kept as a rollback copy |
| Candidate `--version` | `opencode v2.1.2-unguarded.3` |
| Production `~/.local/bin/opencode` unchanged | SHA-256 `29eec08dde53b320744ed7a878c2e9ee77a2992dcf21bd023a4762dac94d8361`, version `1.19.3` |
| `debug paths` | profile, DB, and state all under `~/.local/share/opencode-unguarded/profile` |
| `upgrade --method npm` | refused with derivative guidance, exit 1 |
| Candidate service registration | `derivative: "opencode-unguarded"`, port 47499 |
| Stock 2.1.2 and candidate simultaneously | two listeners (49374 and 47499), two distinct registrations |
| Stopping the candidate | stock service and registration unaffected |
| Functional task in a disposable project | read `math.py`, reported `add(2, 3) == 6`, no edits |

## Known limits

- The telemetry runtime check exercises CLI server startup. Browser and desktop
  integrations are verified by source identity, focused source tests, and type
  checks, not by a running browser or Electron process.
- Project and managed configuration keep upstream loading behavior by design; they
  are not redirected into the profile.
- Provider-side moderation and model training are outside the client's control.
- Byte-for-byte reproducible builds have not been demonstrated; the recorded
  provenance ties an artifact to its source, manifest, toolchain, and workflow run
  but does not claim independent rebuild equality.
- Lifecycle destructiveness is tested with disposable installations and fixture
  roots. The production installation receives only read-only identity checks.
- A stale `.2` candidate service was found running from an earlier test profile
  (`/tmp/rel2-profile`) holding port 47499. Its registration carried no derivative
  marker, which is exactly the `.2` defect this revision fixes. It was stopped
  before the coexistence test. No production process was involved.
- The `.2` profile at `~/.local/share/opencode-unguarded/profile` was reused in
  place; revision 3 creates no incompatible schema change in that directory and
  the candidate started normally against it.
