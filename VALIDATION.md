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
| Derivative revision | 6 |
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
| `.4` | Canonical removal and installer preflight, but a later review found: a 404 health response still authorized a signal; another derivative revision was indistinguishable; uninstall did not prove the executable belonged to the installation; installer rollback missed some post-activation failures; raw-binary containment was incomplete; dry run wrote files; a synthesized HEAD passed identity checks; and the telemetry harness exercised no session. Superseded. |
| `.5` | Separate build, installation, and process-lifetime identity. A later review found that service checks never compared the registration with the *calling* installation, uninstall accepted records the client could not read, raw-binary containment was incomplete, and release evidence covered fewer tests than reported. Superseded. |

Revision 6 closes those defects. Its release workflow runs the canonical check on
the patched tree, both clients' upstream lifecycle suites plus the derivative
suites, and packaged acceptance against exactly the packaged bytes.

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

Revision 4 closed the installer, discovery, and removal defects found in `.3`.
It was superseded because a 404 health response could still authorize a signal,
another derivative revision was indistinguishable from the running one, and
installer rollback did not cover every failure after activation.

## Revision 5 acceptance

Revision 5 added separate build, installation, and process-lifetime identity and
closed the earlier installer and removal defects. It was superseded because
service checks compared the registration with the endpoint but never with the
calling installation, uninstall accepted registrations the client could not read,
raw-binary containment was incomplete, the install/rollback edge cases and patch
identity remained partial, and release evidence was weaker than claimed.

## Revision 6 acceptance

### Source and tooling

| Check | Evidence |
| --- | --- |
| 103 derivative tooling tests | `cd test && bun test unguarded/` |
| Client suites: 77 tests / 6 files | local run |
| CLI suites: 32 tests / 6 files | local run |
| Util derivative + OTLP: 4 tests | local run |
| Canonical `bun run check` | 34/34 tasks, in CI on the patched release tree |
| 6/6 validation gates on the final binary | `validate.ts --release ... --binary` |

### Defect-specific regressions

| Defect | Test |
| --- | --- |
| Another installation sharing a profile | `unguarded-ownership.test.ts` and `unguarded-termination.test.ts` refuse for both clients; a live run confirmed installation B cannot stop A's service |
| Caller without an installation identity | probe refuses rather than adopting |
| Inherited installation root | `installation.ts` only honors a root containing the running executable |
| Malformed registration skipped shutdown | uninstall test with a readable-but-incomplete record refuses removal |
| Tampered executable | installed acceptance refuses when the recorded hash does not match |
| Uninstall inside the profile | installer test |
| Raw-binary config/nested/DB escapes | live checks against the built binary |
| Stale process lifetime | probe reports `lifecycle-mismatch` |
| Session never executed a tool | the offline stub requests `read`; harness and acceptance fail without the tool result |
| Dry run created a profile | acceptance runs a dry run with a nonexistent profile and asserts it stays absent |

### Installed acceptance (revision 6)

Filled in after publication; the local packaged acceptance passed install,
database overrides, read-only dry run (existing and missing profile), live service
identity, a session with a real tool call, and uninstall.

## Known limits

- The telemetry runtime check exercises server startup and a real session through
  an offline model stub. Browser and desktop integrations are verified by source
  identity, focused source tests, and type checks, not by a running browser or
  Electron process.
- Project and managed configuration keep upstream loading behavior by design; they
  are not redirected into the profile.
- Provider-side moderation and model training are outside the client's control.
- Byte-for-byte reproducible builds have not been demonstrated; the recorded
  provenance ties an artifact to its source, manifest, toolchain, and workflow run
  but does not claim independent rebuild equality.
- Lifecycle destructiveness is tested with disposable installations and fixture
  roots. The production installation receives only read-only identity checks.
- A running `.2`, `.3`, or `.4` service is not force-migrated. Those registrations
  lack the revision or installation identity revision 5 requires, so it refuses to
  adopt them and reports the conflict. Stop the old service, then start `.5`; the
  candidate never signals a service it cannot verify.
- Termination safety relies on the authenticated live identity, the registration
  identity, and (on Linux) the process start time. A forceful signal is never sent
  to a PID that fails verification.
- An unreadable Git metadata file is treated as an unverified source and rejected.
- The optional profile-purge flag was removed; uninstall always keeps profile data.
