# Validation record

This file records what the current revision verified, with the evidence for each
claim. Results are labelled by where they were produced: local execution, CI, or
an installed acceptance run. A check that was only inspected statically is not
presented as runtime proof.

## Baseline

| Field | Value |
| --- | --- |
| Package | `@opencode/cli` |
| Version | 2.1.2 |
| Tag | v2.1.2 |
| Commit | a517687fde98a7329ada3ae644a01a9fc6c4e99e |
| npm integrity | `sha512-9mBVQTO3WkKzP300NtHuhmXkHTfR2JwFB0AKRGRw4Lt3SNEwo5V4pzXXrwlpRAHoQmINLPuFPGOmn1kxYZdmMQ==` |
| Derivative revision | 7 |
| Target | linux-x64 |
| Toolchain | Bun 1.4.2, Node v24.22.0 (release) |

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
| `.6` | Bound lifecycle operations to the calling installation. A deeper review found that startup and failed-boot health responses omitted that identity, a direct start could displace a live foreign registration, derivative termination still escalated by numeric PID, saved service environment could reintroduce a rejected override, removal did not verify exclusive ownership, and several runtime edits were absent from the manifest. Superseded. |

Revision 7 closes the `.6` defects. Every intended runtime change is declared in
the manifest, so the assembled release tree is the reviewed source plus nothing
else. The release workflow runs canonical lint and a scoped typecheck, both
clients' suites, the CLI and util derivative suites, generated-artifact
freshness, the telemetry harness, and packaged acceptance against exactly the
packaged bytes.

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

## Revision 6 acceptance (superseded)

### Source and tooling

| Check | Evidence |
| --- | --- |
| 103 derivative tooling tests | `cd test && bun test unguarded/` |
| Client suites: 77 tests / 6 files | local run |
| CLI suites: 32 tests / 6 files | local run |
| Util derivative + OTLP: 4 tests | local run |
| Canonical `bun run check` | 34/34 tasks, locally on the derivative checkout (the release tree now uses canonical lint plus a scoped typecheck) |
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

| Check | Result |
| --- | --- |
| Installed executable hash | `f9449e152c5d3ceb1141f80e7f64052af2e9d8c773103b5db7e155bd9e1fbe00` (revision 6; superseded) |
| Installed launcher hash | `634276adfb694234d3e713a5e9cfed750d475843051340266c4b8d14de41207f` (revision 6; superseded) |
| Published vs installed | identical executable and launcher hashes at the time of the `.6` install |
| Installation identity preserved across replacement | same `installationId` before and after |
| Production executable unchanged | `29eec08dde53b320744ed7a878c2e9ee77a2992dcf21bd023a4762dac94d8361`, `1.19.3` |
| Candidate `--version` | `opencode v2.1.2-unguarded.6` |
| `debug paths` | profile data and database under the candidate profile |
| Dry run, missing profile | exit 0 and the profile was not created |
| Decoy installation root | refused, decoy directory intact |
| Functional task with a real tool call | offline stub requested `read`; the installed client executed it and reported the file contents |
| Stock 2.1.2 + candidate simultaneously | 49374 and 47499, distinct registrations |
| Stop candidate only | stock service and registration unaffected |
| Packaged acceptance of the downloaded archive | all checks passed |

### Revision 7 verification

| Check | Result | Where |
| --- | --- | --- |
| Derivative tooling tests | 103 pass / 7 files / 497 assertions | local |
| Client suites | 256 pass / 23 files / 995 assertions | local |
| CLI suites (upstream + derivative) | 42 pass / 8 files | local |
| Util suites | 110 pass / 16 files | local |
| Core routing/permission suites | 33 pass / 4 files | local |
| Canonical `bun run check` | 34/34 tasks | local |
| Validation gates on the built binary | 6 passed, 0 failed, 0 blocked | local |
| Telemetry harness | stock emitted OTLP; candidate emitted none | local |
| Packaged acceptance (downloaded archive) | all checks passed | local |
| CI check workflow | success | CI |

### Revision 7 defect regressions

| Defect | Test or observation |
| --- | --- |
| Startup identity omitted | `server/identity.ts` is shared by the early health response and the ready handler; `packages/server/src/process.ts` |
| Direct start displacing a live foreign owner | `service-registration.ts` checks the existing record; packaged acceptance cross-installation case |
| Numeric-PID termination | `unguarded-termination.test.ts` requires instance control, including refusal for a daemon without it |
| Stale cleanup without authority | `unguarded-termination.test.ts` preserves another installation's stale record |
| Inherited PTY handoff effects | `daemon.ts` claims ownership before migrating or shutting down |
| Credentials in logs | `unguarded-redact.test.ts` |
| Default-profile and descendant storage escapes | `unguarded-direct-roots.test.ts` |
| Saved service environment bypass | `service-config.ts` rejects the redirecting variables before spawning |
| Recursive removal of unowned files | `uninstall.ts` inventory check; packaged acceptance unowned-content case |
| Archive membership and rollback | `install.test.ts`; `install.sh` |
| Worktree drift and `--check` identity | `verifyWorktreeIdentity`; `apply.ts` |
| Stale generated artifacts | `check:generated` in the release workflow and in CI |
| Tool result not verified | unpredictable expected value in `model-stub.ts` and both harnesses |

### Published artifact (.7)

| Field | Value |
| --- | --- |
| Release | https://github.com/SupperTomato/opencode-unguarded/releases/tag/v2.1.2-unguarded.7 |
| Release target commit | `1ba97bee12ea61bf366b3fbb307bec10a698657b` |
| Build/publish run | https://github.com/SupperTomato/opencode-unguarded/actions/runs/39702152836 |
| Archive SHA-256 | verified with the published `checksums.sha256` |
| Executable SHA-256 | `d03904124027cfef17c54975fc0fc91f85b7db01916b48ab294bc96dec335422` |
| Launcher SHA-256 | `e14a970ac94a9bcc7ac5a191e3b9df49fa413c5d6220259543dce589503060cf` |
| Manifest SHA-256 | `d3ec58b9a27d3bf7376f5a24f19b5d92105ca01d6aa88d1af66526204ab7542e` |
| Toolchain | Bun 1.4.2, Node v24.22.0 |

The downloaded archive was verified against its checksum and extracted. Its
metadata matches the local manifest, the executable and launcher match the
recorded hashes, and packaged acceptance passed install, database overrides,
read-only dry run for an existing and a missing profile, live service identity, a
managed session with a verified tool result, cross-installation refusal, malformed
registration refusal, tampered-metadata refusal, unowned-content refusal, and
uninstall while the service was running.

### Installed acceptance (revision 7)

| Check | Result |
| --- | --- |
| Installed executable hash | matches the published `d0390412…` |
| Installed launcher hash | matches the published `e14a970a…` |
| `--version` | `opencode v2.1.2-unguarded.7` |
| Installation identity preserved across replacement | `150aa94d7e7d30e291c289f13e0b22cd` |
| Durable profile preserved | `debug paths` resolves inside the existing profile |
| Service status / start / restart | running service reported, restarted, and alive afterwards |
| Cross-installation stop | refused with `installation-mismatch`, exit 1, owner still running |
| Functional task | offline stub; the client executed a real read and reported the file contents |
| Production executable | unchanged `29eec08d…`, version `1.19.3` |
| Unrelated user processes | unchanged |

## Known limits

- The telemetry runtime check exercises server startup and a real session through
  an offline model stub that requests a tool call, so a session that never
  executed a tool fails the check. Browser and desktop integrations are verified by source
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
- A running service from an earlier revision is not force-migrated. Its
  registration lacks the revision or installation identity this revision
  requires, so it refuses to adopt it and reports the conflict. Stop the old
  service, then start the current one; the candidate never signals a service it
  cannot verify.
- Termination safety relies on the authenticated live identity, the registration
  identity, the caller's installation, and (on Linux) the process start time. A
  forceful signal is never sent to a PID that fails verification.
- The release workflow runs canonical lint and a typecheck that excludes the two
  Astro documentation services. In the nested release checkout, `astro sync`
  cannot resolve the hoisted `@tsconfig/bun` inside the services workspace; this
  failure reproduces in CI but not locally, and its root cause is not established.
  The workflow refuses to run if the manifest touches either documentation site,
  so no reviewed change can be hidden by the exclusion. The full `bun run check`,
  including both sites, runs on the derivative checkout in `check.yml`.
- An unreadable Git metadata file is treated as an unverified source and rejected.
- The optional profile-purge flag was removed; uninstall always keeps profile data.

## Known limits (revision 7)

- Termination is instance-bound on Linux: the client authenticates to the live
  daemon and names the instance and process lifetime, and the daemon refuses a
  mismatch. Stock builds retain upstream numeric signalling by design.
- Concurrent `service set` writes still share a temporary filename without a
  lock. This is inherited behavior and is not part of the accepted lifecycle
  contract; it is recorded here rather than silently fixed.
- Stateless generation (`/api/experimental/generate` and the plugin host's
  `generate.text`) does not use session prompt routing. The directive applies to
  session prompts, which is what the accepted scope covers.
- Browser and desktop reporting paths are removed at source level and verified by
  source identity and type checks. No released desktop artifact was exercised.
- The telemetry harness observes the configured OTLP endpoints during the
  operations it runs. It does not prove universal absence of network activity.
- The release workflow's typecheck excludes the two Astro documentation sites
  under the condition described in Known limits; the full canonical check runs on
  the derivative checkout.
