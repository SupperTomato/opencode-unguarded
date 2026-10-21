#!/usr/bin/env bun

/**
 * Lifecycle patches for the derivative.
 *
 * These keep the candidate inside its own installation boundary:
 *  - `upgrade` must never run the upstream installer
 *  - the service identity must not collide with a stock install
 *
 * They are applied to the pinned upstream checkout at build time, like the
 * guardrail and telemetry patches, and verified fail-closed.
 */

import fs from "node:fs"
import path from "node:path"

export type Change = { file: string; reason: string }

const MARKER = "opencode-unguarded: derivative lifecycle"
const UPGRADE = "packages/cli/src/commands/handlers/upgrade.ts"
const SERVICE_CONFIG = "packages/cli/src/services/service-config.ts"
const DATABASE_PATH = "packages/cli/src/database-path.ts"

const CHANNEL = "unguarded"
const PORT = 47499

function fail(message: string): never {
  throw new Error(message)
}

function resolveTarget(root: string, file: string) {
  const realRoot = fs.realpathSync(root)
  const candidate = path.resolve(realRoot, file)
  const relative = path.relative(realRoot, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`refusing to touch ${file} outside ${root}`)
  return candidate
}

function read(root: string, file: string) {
  const full = resolveTarget(root, file)
  if (!fs.existsSync(full)) fail(`missing file: ${file}`)
  return fs.readFileSync(full, "utf8")
}

function update(root: string, file: string, reason: string, transform: (content: string) => string, changes: Change[]) {
  const before = read(root, file)
  const after = transform(before)
  if (after === before) return
  fs.writeFileSync(resolveTarget(root, file), after)
  changes.push({ file, reason })
}

export function patchLifecycle(root: string) {
  if (!fs.existsSync(resolveTarget(root, "packages/cli/package.json")))
    fail(`not an OpenCode checkout: ${root}`)
  const changes: Change[] = []

  // 1. Refuse to hand control to the upstream installer.
  update(
    root,
    UPGRADE,
    "refuse upstream upgrade paths so the candidate cannot replace itself with stock OpenCode",
    (content) => {
      if (content.includes(MARKER)) return content
      const anchor = '      intro("Upgrade")\n'
      if (!content.includes(anchor)) fail(`${UPGRADE}: expected intro() call not found; refusing to guess`)
      return content.replace(
        anchor,
        `${anchor}      // ${MARKER}: the derivative does not self-update through upstream.
      if (!Option.getOrUndefined(input.method)) {
        return yield* Effect.fail(
          new Error(
            [
              "opencode-unguarded does not self-update through the upstream installer.",
              "",
              "Update this derivative from its own releases:",
              "  https://github.com/SupperTomato/opencode-unguarded/releases",
              "",
              "Download the newer opencode-unguarded-linux-x64.tar.gz, verify checksums.sha256,",
              "and replace this installation. Your profile at $OPENCODE_UNGUARDED_PROFILE is kept.",
            ].join("\\n"),
          ),
        )
      }
`,
      )
    },
    changes,
  )

  // 2. Give the candidate its own service registration, port, and database name.
  update(
    root,
    SERVICE_CONFIG,
    "assign the derivative a distinct service identity so it can run beside stock OpenCode",
    (content) => {
      if (content.includes(MARKER)) return content
      const anchor = 'export function filename(channel = OPENCODE_CHANNEL) {\n'
      if (!content.includes(anchor)) fail(`${SERVICE_CONFIG}: filename() not found; refusing to guess`)
      let result = content.replace(
        anchor,
        `// ${MARKER}: a distinct channel keeps registrations, ports, and databases apart.\n` +
          `export const DERIVATIVE_CHANNEL = "${CHANNEL}"\n\n` +
          anchor,
      )
      const portAnchor = 'export function defaultPort(channel = OPENCODE_CHANNEL, platform = process.platform) {\n'
      if (!result.includes(portAnchor)) fail(`${SERVICE_CONFIG}: defaultPort() not found; refusing to guess`)
      result = result.replace(
        portAnchor,
        portAnchor +
          `  if (channel === DERIVATIVE_CHANNEL) return ${PORT}\n`,
      )
      return result
    },
    changes,
  )

  update(
    root,
    DATABASE_PATH,
    "use a derivative-specific database filename",
    (content) => {
      if (content.includes(MARKER)) return content
      const anchor = "export function databasePath(data: string) {\n"
      if (!content.includes(anchor)) fail(`${DATABASE_PATH}: databasePath() not found; refusing to guess`)
      return content.replace(
        anchor,
        anchor +
          `  // ${MARKER}: keep the derivative database separate from stock installs.\n` +
          `  if (!process.env.OPENCODE_DB) return path.resolve(data, "opencode-unguarded.db")\n`,
      )
    },
    changes,
  )

  return changes
}

export function verifyLifecycle(root: string) {
  const errors: string[] = []

  const upgrade = read(root, UPGRADE)
  if (!upgrade.includes(MARKER)) errors.push(`${UPGRADE}: derivative upgrade guard missing`)
  if (!upgrade.includes("does not self-update through the upstream installer"))
    errors.push(`${UPGRADE}: derivative upgrade message missing`)

  const service = read(root, SERVICE_CONFIG)
  if (!service.includes(`export const DERIVATIVE_CHANNEL = "${CHANNEL}"`))
    errors.push(`${SERVICE_CONFIG}: derivative channel missing`)
  if (!new RegExp(`if \\(channel === DERIVATIVE_CHANNEL\\) return ${PORT}`).test(service))
    errors.push(`${SERVICE_CONFIG}: derivative port ${PORT} not assigned`)

  const database = read(root, DATABASE_PATH)
  if (!database.includes("opencode-unguarded.db")) errors.push(`${DATABASE_PATH}: derivative database name missing`)

  return errors
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".")
  try {
    if (!check) {
      const changes = patchLifecycle(root)
      for (const change of changes) console.log(`patched ${change.file}: ${change.reason}`)
      if (changes.length === 0) console.log("no changes needed (already patched)")
    }
    const errors = verifyLifecycle(root)
    if (errors.length > 0) {
      console.error("Lifecycle verification failed:")
      for (const error of errors) console.error(`- ${error}`)
      process.exit(1)
    }
    console.log("lifecycle verification passed")
  } catch (error) {
    console.error(`lifecycle patch failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
