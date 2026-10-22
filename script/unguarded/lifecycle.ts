#!/usr/bin/env bun

/**
 * Lifecycle verification for the derivative.
 *
 * The reviewed lifecycle source is pinned by the manifest like every other
 * patch target, so `apply.ts` is the single writer. This module verifies the
 * invariants that must hold in the built source and the packaged artifacts:
 *
 *  - every upstream update route is refused at the shared updater boundary
 *  - registrations carry a derivative ownership marker
 *  - the candidate uses its own channel, port, and database filename
 */

import { cliRoot, exists, loadManifest, positional, read, type Manifest } from "./lib/patch"

export type Change = { file: string; reason: string }

const UPGRADE = "packages/cli/src/commands/handlers/upgrade.ts"
const UPDATER = "packages/cli/src/services/updater.ts"
const SERVICE_CONFIG = "packages/cli/src/services/service-config.ts"
const REGISTRATION = "packages/cli/src/services/service-registration.ts"
const UNINSTALL = "packages/cli/src/commands/handlers/uninstall.ts"
const DATABASE_PATH = "packages/cli/src/database-path.ts"
const VERSION = "packages/cli/src/version.ts"

const CLIENT_PROBE = "packages/client/src/service-probe.ts"
const CLIENT_EFFECT = "packages/client/src/effect/service.ts"
const CLIENT_PROMISE = "packages/client/src/promise/service.ts"
const SERVER_PROCESS = "packages/cli/src/server-process.ts"
const PROTOCOL_SERVER = "packages/protocol/src/groups/server.ts"
const GLOBAL_ROOTS = "packages/util/src/global-roots.ts"

const PORT = 47499
const DATABASE = "opencode-unguarded.db"

/**
 * The updater is the only place that can start an upstream installer. Every
 * entry point must consult the compiled derivative flag, so a new caller cannot
 * quietly bypass an earlier per-command guard.
 */
export function verifyUpdaterBoundary(root: string) {
  const errors: string[] = []
  const updater = read(root, UPDATER)
  for (const [name, pattern] of [
    ["upgrade", /const upgrade = Effect\.fnUntraced\(function\* \(method: Method, input: string\) \{\s*if \(UNGUARDED\)/],
    ["install", /const install = Effect\.fnUntraced\(function\* \(version: string\) \{\s*if \(UNGUARDED\)/],
    ["run", /if \(UNGUARDED\) return undefined\s*\n\s*const result = yield\* inspect\(\)/],
    ["check", /if \(UNGUARDED\)[\s\S]{0,120}type: "unavailable"/],
    ["latest", /const latest = Effect\.fnUntraced\(function\* \(selected\?: Method\) \{\s*if \(UNGUARDED\) return yield\* Effect\.fail\(derivativeUpdateError\(\)\)/],
    ["removal", /const removal = \(method: Method\) => \{\s*if \(UNGUARDED\) return undefined/],
  ] as const) {
    if (!pattern.test(updater)) errors.push(`${UPDATER}: ${name}() does not enforce the derivative boundary`)
  }
  if (!updater.includes("DERIVATIVE_UPDATE_MESSAGE"))
    errors.push(`${UPDATER}: derivative update guidance is missing`)

  const upgrade = read(root, UPGRADE)
  if (!/if \(UNGUARDED\) return yield\* Effect\.fail\(new Error\(Updater\.DERIVATIVE_UPDATE_MESSAGE\)\)/.test(upgrade))
    errors.push(`${UPGRADE}: the upgrade command does not refuse before resolving a method`)

  return errors
}

export function verifyServiceOwnership(root: string) {
  const errors: string[] = []
  const version = read(root, VERSION)
  if (!/export const UNGUARDED = typeof OPENCODE_UNGUARDED === "boolean" && OPENCODE_UNGUARDED/.test(version))
    errors.push(`${VERSION}: the derivative flag is not compiled in`)
  if (!version.includes('name: "opencode-unguarded"'))
    errors.push(`${VERSION}: derivative identity is missing`)

  const registration = read(root, REGISTRATION)
  // The registration must carry the distribution and the revision, and the
  // self-ownership check must compare both plus the installation identity.
  if (!registration.includes("derivative: options.derivative"))
    errors.push(`${REGISTRATION}: registrations are not marked with the derivative build identity`)
  if (!registration.includes("derivativeRevision: options.derivativeRevision"))
    errors.push(`${REGISTRATION}: registrations are not marked with the derivative revision`)
  if (!registration.includes("installation: options.installation"))
    errors.push(`${REGISTRATION}: registrations are not marked with an installation identity`)
  if (!/found\.derivativeRevision === info\.derivativeRevision/.test(registration))
    errors.push(`${REGISTRATION}: registration ownership does not compare the derivative revision`)
  if (!/found\.installation === info\.installation/.test(registration))
    errors.push(`${REGISTRATION}: registration ownership does not compare the installation identity`)

  const service = read(root, SERVICE_CONFIG)
  if (!service.includes('export const DERIVATIVE_CHANNEL = "unguarded"'))
    errors.push(`${SERVICE_CONFIG}: derivative channel missing`)
  if (!new RegExp(`if \\(channel === DERIVATIVE_CHANNEL\\) return ${PORT}`).test(service))
    errors.push(`${SERVICE_CONFIG}: derivative port ${PORT} not assigned`)
  if (!/registration\.derivative === UNGUARDED_IDENTITY\.name/.test(service))
    errors.push(`${SERVICE_CONFIG}: stock registration migration is not rejected`)
  if (!/registration\.derivativeRevision === UNGUARDED_IDENTITY\.revision/.test(service))
    errors.push(`${SERVICE_CONFIG}: another derivative revision's registration is still migratable`)
  if (!/!UNGUARDED && name !== "service\.json"/.test(service))
    errors.push(`${SERVICE_CONFIG}: the stock service.json file is still a migration candidate`)

  const database = read(root, DATABASE_PATH)
  if (!/if \(UNGUARDED\) return derivativeDatabasePath\(data\)/.test(database))
    errors.push(`${DATABASE_PATH}: derivative database is not selected`)
  // The rules themselves live with the profile roots so a direct binary and the
  // launcher cannot drift apart.
  const rootsModule = read(root, GLOBAL_ROOTS)
  if (!/export function derivativeDatabasePath/.test(rootsModule))
    errors.push(`${GLOBAL_ROOTS}: derivative database containment is missing`)
  if (!/name === ":memory:"\) return name/.test(rootsModule))
    errors.push(`${GLOBAL_ROOTS}: explicit :memory: override is not honored`)
  if (!/path\.isAbsolute\(name\)/.test(rootsModule))
    errors.push(`${GLOBAL_ROOTS}: absolute database overrides are not rejected`)
  if (!/isSymbolicLink\(\)\)/.test(rootsModule))
    errors.push(`${GLOBAL_ROOTS}: a symlinked database is not rejected`)

  return errors
}

/**
 * Termination and storage invariants that used to be enforced only by the
 * launcher or only by a marker string. These are source fingerprints, not
 * behavioral proof: the behavioral suites run separately.
 */
export function verifySignalSafety(root: string) {
  const errors: string[] = []
  const probe = read(root, CLIENT_PROBE)
  if (!/export function ownedByThisBuild/.test(probe))
    errors.push(`${CLIENT_PROBE}: build ownership predicate is missing`)
  if (!/info\.derivativeRevision === undefined\) return false/.test(probe))
    errors.push(`${CLIENT_PROBE}: a revision-less registration is still accepted`)
  if (!/return info\.derivativeRevision === identity\.revision/.test(probe))
    errors.push(`${CLIENT_PROBE}: another derivative revision is still accepted`)
  if (!/if \(DERIVATIVE\) return \{ status: "incompatible", reason: "not-found"/.test(probe))
    errors.push(`${CLIENT_PROBE}: a 404 health response is not refused for derivative builds`)
  if (!/export function ownerExited/.test(probe))
    errors.push(`${CLIENT_PROBE}: provably-exited owner detection is missing`)

  for (const file of [CLIENT_EFFECT, CLIENT_PROMISE]) {
    const client = read(root, file)
    if (!/if \(isDerivative\(\)\) \{/.test(client))
      errors.push(`${file}: termination is not scoped to the derivative build`)
    if (!client.includes("ownerExited"))
      errors.push(`${file}: termination does not recognize a provably exited owner`)
    if (!/probe\.status !== "verified"/.test(client))
      errors.push(`${file}: termination does not require a verified owner`)
    // Lifetime agreement is enforced inside the probe, so every caller gets it.
    if (!/lifecycle-mismatch/.test(probe))
      errors.push(`${CLIENT_PROBE}: the registration and live process lifetime are not compared`)
    if (!client.includes("options.installation"))
      errors.push(`${file}: termination does not bind to the caller's installation`)
    // A derivative stop must ask the addressed instance, never signal a PID.
    if (!/shutdownInstance\(/.test(client))
      errors.push(`${file}: derivative termination does not use instance-bound shutdown`)
    if (!/authorizedRecord\(/.test(client))
      errors.push(`${file}: stale records are not authorized before cleanup`)
    if (/signal\(info\.pid|signal\(pid, name\)/.test(client.replace(/signalStock/g, "")))
      errors.push(`${file}: derivative termination still signals a numeric PID`)
  }

  const control = read(root, "packages/client/src/service-control.ts")
  if (!/authorizedRecord/.test(control))
    errors.push("packages/client/src/service-control.ts: stale cleanup is not authorized")
  if (!/shutdownInstance/.test(control))
    errors.push("packages/client/src/service-control.ts: instance-bound shutdown is missing")
  const decoder = read(root, "packages/client/src/service-registration-decoder.ts")
  if (!/decodeRegistration/.test(decoder))
    errors.push("packages/client/src/service-registration-decoder.ts: the shared registration contract is missing")

  const registration = read(root, REGISTRATION)
  if (!registration.includes("derivativeRevision: options.derivativeRevision"))
    errors.push(`${REGISTRATION}: the live build identity is not advertised`)

  const serverProcess = read(root, SERVER_PROCESS)
  if (!/Installation\.installationIdentity\(\)/.test(serverProcess))
    errors.push(`${SERVER_PROCESS}: the managed service does not record its installation`)
  if (!/ProcessIdentity\.processStartTime\(\)/.test(serverProcess))
    errors.push(`${SERVER_PROCESS}: the managed service does not record its process lifetime`)

  const protocol = read(root, PROTOCOL_SERVER)
  for (const field of ["derivative", "derivativeRevision", "installation", "startTime"]) {
    if (!new RegExp(`${field}: Schema\\.optional`).test(protocol))
      errors.push(`${PROTOCOL_SERVER}: server info does not expose ${field}`)
  }

  const probeSource = read(root, CLIENT_PROBE)
  if (!/export function ownedByCaller/.test(probeSource))
    errors.push(`${CLIENT_PROBE}: the caller's installation is not verified`)
  if (!/if \(!DERIVATIVE\) return true\s*\n\s*if \(expected === undefined\) return false/.test(probeSource))
    errors.push(`${CLIENT_PROBE}: a caller without an installation identity is still accepted`)

  const serviceConfig = read(root, SERVICE_CONFIG)
  if (!/installation: Installation\.installationIdentity\(\)\.id/.test(serviceConfig))
    errors.push(`${SERVICE_CONFIG}: CLI calls do not pass their own installation identity`)

  const installModule = read(root, "packages/cli/src/services/installation.ts")
  // Identity comes from the executable's own installed layout, never from a
  // claimed environment root, and metadata is accepted only for those exact bytes.
  if (!/path\.basename\(canonicalExecutable\) !== "opencode"\) return undefined/.test(installModule))
    errors.push("packages/cli/src/services/installation.ts: identity is not derived from the installed layout")
  if (!/executableSha256/.test(installModule))
    errors.push("packages/cli/src/services/installation.ts: installation metadata is not bound to the executable bytes")


  const roots = read(root, GLOBAL_ROOTS)
  if (!/function derivativeProfile\(\)/.test(roots))
    errors.push(`${GLOBAL_ROOTS}: the executable does not resolve its own profile`)
  if (!/path\.isAbsolute\(requested\)/.test(roots))
    errors.push(`${GLOBAL_ROOTS}: a relative profile is not rejected by the executable`)
  if (!/canonicalExistingAncestor/.test(roots))
    errors.push(`${GLOBAL_ROOTS}: profile containment does not resolve symlinked ancestors`)
  return errors
}

export function verifyDerivativeUninstall(root: string) {
  const errors: string[] = []
  const uninstall = read(root, UNINSTALL)
  if (!/if \(UNGUARDED\) return yield\* uninstallDerivative\(input\)/.test(uninstall))
    errors.push(`${UNINSTALL}: the derivative removal path is not selected`)
  const start = uninstall.indexOf("const uninstallDerivative")
  if (start === -1) {
    errors.push(`${UNINSTALL}: derivative removal implementation is missing`)
    return errors
  }
  const body = uninstall.slice(start)
  if (!body.includes("OPENCODE_UNGUARDED_ROOT"))
    errors.push(`${UNINSTALL}: removal does not require a verified installation root`)
  if (!body.includes("verifyInstallationOwnership"))
    errors.push(`${UNINSTALL}: removal does not verify that the executable belongs to the installation`)
  if (!/registrationBelongsToInstallation\(owned, ownership\)/.test(body))
    errors.push(`${UNINSTALL}: removal does not bind the service to this installation`)
  if (!/overlaps the application profile/.test(body))
    errors.push(`${UNINSTALL}: removal does not reject profile overlap`)
  if (!/unexpectedEntries/.test(body))
    errors.push(`${UNINSTALL}: removal does not verify exclusive ownership of the root contents`)
  if (!/launcherSha256/.test(body))
    errors.push(`${UNINSTALL}: removal does not verify the launcher hash`)
  if (!/parseRegistration/.test(body))
    errors.push(`${UNINSTALL}: removal does not use the shared registration contract`)
  if (!/realPath\(root\)/.test(body))
    errors.push(`${UNINSTALL}: removal does not canonicalize the installation root`)
  if (!/service-unguarded\.json/.test(body))
    errors.push(`${UNINSTALL}: removal does not target the derivative registration`)
  for (const forbidden of ["updater.removal(", "cleanShellConfig", "rm -rf"]) {
    if (body.includes(forbidden))
      errors.push(`${UNINSTALL}: derivative removal still uses upstream cleanup (${forbidden})`)
  }
  return errors
}

export function verifyLifecycle(root: string, manifest: Manifest = loadManifest("2.1.2")) {
  const errors = [
    ...verifyUpdaterBoundary(root),
    ...verifyServiceOwnership(root),
    ...verifyDerivativeUninstall(root),
    ...verifySignalSafety(root),
  ]
  for (const entry of manifest.files) {
    if (!exists(root, entry.file)) errors.push(`${entry.file}: required file is missing`)
  }
  return errors
}

export function patchLifecycle(_root: string, _manifest?: Manifest): Change[] {
  throw new Error(
    "lifecycle patches are applied by script/unguarded/apply.ts; run it with the pinned version instead",
  )
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const root = cliRoot(args)
  const version = positional(args, ["--root"])[0]
  try {
    if (!args.includes("--check")) {
      console.error("lifecycle patches are applied by script/unguarded/apply.ts; re-run with --check to verify")
      process.exit(2)
    }
    const errors = verifyLifecycle(root, version ? loadManifest(version) : undefined)
    if (errors.length > 0) {
      console.error("Lifecycle verification failed:")
      for (const error of errors) console.error(`- ${error}`)
      process.exit(1)
    }
    console.log("lifecycle verification passed")
  } catch (error) {
    console.error(`lifecycle verification failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
