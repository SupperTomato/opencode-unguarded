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

import { cliRoot, exists, loadManifest, read, type Manifest } from "./lib/patch"

export type Change = { file: string; reason: string }

const UPGRADE = "packages/cli/src/commands/handlers/upgrade.ts"
const UPDATER = "packages/cli/src/services/updater.ts"
const SERVICE_CONFIG = "packages/cli/src/services/service-config.ts"
const REGISTRATION = "packages/cli/src/services/service-registration.ts"
const UNINSTALL = "packages/cli/src/commands/handlers/uninstall.ts"
const DATABASE_PATH = "packages/cli/src/database-path.ts"
const VERSION = "packages/cli/src/version.ts"

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
  if (!/\.\.\.\(UNGUARDED \? \{ derivative: UNGUARDED_IDENTITY\.name \} : \{\}\)/.test(registration))
    errors.push(`${REGISTRATION}: registrations are not marked as derivative-owned`)
  if (!/found\.derivative === info\.derivative/.test(registration))
    errors.push(`${REGISTRATION}: registration ownership is not compared`)

  const service = read(root, SERVICE_CONFIG)
  if (!service.includes('export const DERIVATIVE_CHANNEL = "unguarded"'))
    errors.push(`${SERVICE_CONFIG}: derivative channel missing`)
  if (!new RegExp(`if \\(channel === DERIVATIVE_CHANNEL\\) return ${PORT}`).test(service))
    errors.push(`${SERVICE_CONFIG}: derivative port ${PORT} not assigned`)
  if (!/registration\.derivative === UNGUARDED_IDENTITY\.name/.test(service))
    errors.push(`${SERVICE_CONFIG}: stock registration migration is not rejected`)
  if (!/!UNGUARDED && name !== "service\.json"/.test(service))
    errors.push(`${SERVICE_CONFIG}: the stock service.json file is still a migration candidate`)

  const database = read(root, DATABASE_PATH)
  if (!/if \(UNGUARDED\) return path\.resolve\(data, "opencode-unguarded\.db"\)/.test(database))
    errors.push(`${DATABASE_PATH}: derivative database is not selected`)

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
  if (!/found\.derivative === UNGUARDED_IDENTITY\.name/.test(body))
    errors.push(`${UNINSTALL}: removal does not verify service ownership`)
  if (!/service-unguarded\.json/.test(body))
    errors.push(`${UNINSTALL}: removal does not target the derivative registration`)
  for (const forbidden of ["updater.removal(", "cleanShellConfig", "rm -rf", "src/commands"]) {
    if (body.includes(forbidden))
      errors.push(`${UNINSTALL}: derivative removal still uses upstream cleanup (${forbidden})`)
  }
  return errors
}

export function verifyLifecycle(root: string, manifest: Manifest = loadManifest("2.1.2")) {
  const errors = [...verifyUpdaterBoundary(root), ...verifyServiceOwnership(root), ...verifyDerivativeUninstall(root)]
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
  const version = args.find((arg, index) => !arg.startsWith("--") && index !== args.indexOf("--root") + 1)
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
