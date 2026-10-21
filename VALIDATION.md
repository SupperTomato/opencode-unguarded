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
| Derivative revision | 4 |
| Target | linux-x64 |
| Toolchain | Bun 1.4.2, Node 24 |

`@opencode/cli@2.1.2` is the current OpenCode distribution line. `opencode-ai@1.19.3`
is the previous generation; its source layout does not apply here.

## Correction history

| Revision | Outcome |
| --- | --- |
| `.1` | Missed the shared base prompt and some template routes; verifiers accepted incomplete patches. Do not use. |
| `.2` | Added route coverage but left these defects: `--method` reached the upstream installer; startup/TUI paths were unguarded; source identity was version-only; launcher and patch targets followed escaping symlinks; telemetry checks trusted markers; service migration accepted equal versions; uninstall used upstream cleanup; route tests duplicated routing. |
| `.3` | Exact fingerprints and the updater boundary, but a follow-up review found: uninstall could delete a profile inside the install root; the shell uninstaller used the wrong registration path and could remove another install; live discovery ignored the derivative marker; a stale PID could be signalled; nested profile directories and the default database were unchecked; database overrides were ignored; installer checksums were optional and link validation ran after activation; patch planning created directories before preflight; and release CI named two derivative suites it never copied, running 20 CLI tests instead of 26. Superseded. |

Revision 4 closes those defects. Its release run executed 32 CLI tests across 6
files, the client and util derivative suites, and the canonical check.

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

## Revision 4 acceptance

### Source and tooling

| Check | Evidence |
| --- | --- |
| 94 derivative tooling tests | `cd test && bun test unguarded/` |
| 6/6 validation gates on the downloaded binary | `validate.ts --upstream ... --binary ... --release` |
| Canonical `bun run check` | 34/34 typecheck tasks; lint clean |
| CLI suites: 32 tests / 6 files | release run log |
| Client derivative suite: 4 tests | release run log |
| Util derivative suites: 4 tests | release run log |
| Telemetry harness with stock control | candidate `[]`, stock emitted logs and traces |

### Defect-specific regressions

| Defect | Test |
| --- | --- |
| Removal deleting the profile | installer rejects an installation containing the profile; CLI re-checks canonical overlap |
| Wrong-install removal | shell uninstaller delegates to the requested prefix's own launcher |
| Unverified ownership | probe requires the derivative marker and a matching live PID |
| Stale PID signalling | termination refuses when the registered endpoint does not confirm the owner |
| Nested escapes / default DB | launcher rejects symlinked `*/opencode` and a symlinked default database |
| Ignored DB overrides | `:memory:`, plain filename honored; absolute/traversing/nested rejected |
| Optional checksums | installer requires an entry for the exact archive and verifies its digest |
| Link validation after activation | link preflight runs before the previous installation moves |
| Preflight writes | late protected-file rejection leaves the filesystem unchanged |
| Unverified Git identity | worktree metadata is followed; ancestry is proven; synthesized HEAD rejected |
| CI not running derivative suites | staging step copies them and release logs show 32 tests / 6 files |

### Installed acceptance (revision 4)

| Check | Result |
| --- | --- |
| Installed executable hash | `51c1edb52f400b2b0dd03eae4dd3fd8600ee82bb04f4e2be7524e8fc456470bf` |
| Installed launcher hash | `855da306253b07dc3dce55214fd0d0b28ad7255222650c4214fc2609f2f36b52` |
| Published executable/launcher hashes | identical to the installed files |
| Production executable unchanged | `29eec08dde53b320744ed7a878c2e9ee77a2992dcf21bd023a4762dac94d8361`, `1.19.3` |
| Candidate `--version` | `opencode v2.1.2-unguarded.4` |
| `debug paths` | profile data and database under the candidate profile |
| Direct binary without launcher | still uses the candidate default profile |
| Stock 2.1.2 + candidate simultaneously | 49374 and 47499, distinct registrations |
| Stop candidate only | stock service and registration unaffected |
| Functional task | read `math.py`, reported `add(2, 3) == 6`, no edits |

## Published artifact

| Field | Value |
| --- | --- |
| Release | https://github.com/SupperTomato/opencode-unguarded/releases/tag/v2.1.2-unguarded.4 |
| Release target commit | `5fa4038c14e7e01cc318e6213cdb2fa80408695f` |
| Build workflow run | https://github.com/SupperTomato/opencode-unguarded/actions/runs/39613438240 |
| Archive SHA-256 | verified with the published `checksums.sha256` |
| Executable SHA-256 | `51c1edb52f400b2b0dd03eae4dd3fd8600ee82bb04f4e2be7524e8fc456470bf` |
| Launcher SHA-256 | `855da306253b07dc3dce55214fd0d0b28ad7255222650c4214fc2609f2f36b52` |
| Manifest SHA-256 | `316bd747a020413db3726d24897d08eb5a9108711999a1db2268caa27e54d971` |
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
- A running `.2` service is not force-migrated. Its registration lacks the marker,
  so revision 4 refuses to adopt it and reports that the registered service belongs
  to a different distribution. Stop it before starting `.4`; the candidate never
  signals a service it cannot verify.
- An unreadable Git metadata file is treated as an unverified source and rejected.
- The optional profile-purge flag was removed; uninstall always keeps profile data.
