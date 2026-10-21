#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"

export type Change = { file: string; reason: string }

const MARKER = "opencode-unguarded: telemetry disabled at build time"

const OTLP = "packages/util/src/observability/otlp.ts"
const OBSERVABILITY = "packages/util/src/observability.ts"
const APP_ENTRY = "packages/app/src/entry.tsx"
const APP_VITE = "packages/app/vite.config.ts"
const DESKTOP_VITE = "packages/desktop/electron.vite.config.ts"
const DESKTOP_SENTRY = "packages/desktop/src/renderer/startup/sentry.ts"
const OTLP_TEST = "packages/util/test/observability-otlp.test.ts"

const REQUIRED = [OTLP, OBSERVABILITY, APP_ENTRY, APP_VITE, DESKTOP_VITE, DESKTOP_SENTRY]

function fail(message: string): never {
  throw new Error(message)
}

function resolveTarget(root: string, file: string) {
  const realRoot = fs.realpathSync(root)
  const candidate = path.resolve(realRoot, file)
  const relative = path.relative(realRoot, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail(`refusing to touch a path outside the source root: ${file}`)
  return candidate
}

function exists(root: string, file: string) {
  return fs.existsSync(resolveTarget(root, file))
}

function read(root: string, file: string) {
  return fs.readFileSync(resolveTarget(root, file), "utf8")
}

function update(root: string, file: string, reason: string, transform: (content: string) => string, changes: Change[]) {
  const before = read(root, file)
  const after = transform(before)
  if (after === before) return false
  fs.writeFileSync(resolveTarget(root, file), after)
  changes.push({ file, reason })
  return true
}

function replaceFunctionBody(content: string, name: string, body: string) {
  const signature = new RegExp(`export\\s+(?:async\\s+)?(?:const|function)\\s+${name}\\s*[=(][^{]*\\{`, "m")
  const match = signature.exec(content)
  if (!match) fail(`unable to locate ${name}() while disabling OTLP`)
  const open = match.index + match[0].lastIndexOf("{")
  let depth = 0
  for (let index = open; index < content.length; index++) {
    if (content[index] === "{") depth++
    if (content[index] !== "}") continue
    depth--
    if (depth !== 0) continue
    return content.slice(0, open + 1) + body + content.slice(index)
  }
  fail(`unable to find the end of ${name}() while disabling OTLP`)
}

function disableOtlp(root: string, changes: Change[]) {
  update(
    root,
    OTLP,
    "replace OTLP logger and trace exporter with no-ops while retaining resource helpers",
    (content) => {
      let result = replaceFunctionBody(content, "loggers", "\n  return []\n")
      result = replaceFunctionBody(result, "tracingLayer", "\n  return Layer.empty\n")
      result = result.replace(/^import \{ OtlpLogger \} from "effect\/observability"\r?\n/m, "")
      result = result.replace(
        /^export const tracingLayer = Effect\.fnUntraced\(function\* \(options: Options \| undefined, app: App\) \{/m,
        "export const tracingLayer = Effect.fnUntraced(function* (_options: Options | undefined, _app: App) {",
      )
      result = result.replace(
        /^export function loggers\(options: Options \| undefined, app: App\)/m,
        "export function loggers(_options: Options | undefined, _app: App)",
      )
      if (!result.replace(/^import \{[^}]*\} from "effect"$/m, "").includes("Scope"))
        result = result.replace(
          /^import \{ Effect, Layer, Scope \} from "effect"$/m,
          'import { Effect, Layer } from "effect"',
        )
      result = result.replace(/^function parseHeaders\(value\?: string\) \{\n[\s\S]*?\n\}\r?\n\r?\n/m, "")
      const anchor = "function resourceAttributes()"
      if (!result.includes(anchor)) fail(`${OTLP}: resource helper missing; refusing to modify`)
      if (!result.includes(MARKER)) {
        result = result.replace(
          anchor,
          `// ${MARKER}. Resource construction remains for API compatibility,\n// but no logger or trace exporter can be created by release binaries.\n${anchor}`,
        )
      }
      for (const value of ["OTLPTraceExporter", "OtlpLogger", "/v1/traces", "/v1/logs"]) {
        if (result.includes(value)) fail(`${OTLP}: failed to remove exporter capability (${value})`)
      }
      return result
    },
    changes,
  )

  update(
    root,
    OBSERVABILITY,
    "remove OTLP logger, serialization, exporter, and tracing layers; keep local logging",
    (content) => {
      let result = content.replace(/^import \{ FetchHttpClient \} from "effect\/http"\r?\n/m, "")
      result = result.replace(/^import \{ OtlpExporter, OtlpSerialization \} from "effect\/observability"\r?\n/m, "")
      result = result.replace(/^import \{ Otlp \} from "\.\/observability\/otlp\.js"\r?\n/m, "")
      const replaced = result.replace(
        /  return Layer\.unwrap\(\n[\s\S]*?\)\.pipe\(Layer\.catchCause\(\(\) => local\)\)\n/m,
        `  // ${MARKER}: only local logging is installed.\n  return local\n`,
      )
      if (replaced === result && !result.includes(`return local`))
        fail(`${OBSERVABILITY}: layer() shape changed; refusing to guess`)
      result = replaced
      if (!result.includes("Effect."))
        result = result.replace(
          /^import \{ Effect, Layer, Logger, References, Schema \} from "effect"$/m,
          'import { Layer, Logger, References, Schema } from "effect"',
        )
      return result
    },
    changes,
  )
}

function disableSentry(root: string, changes: Change[]) {
  update(
    root,
    APP_ENTRY,
    "remove browser error-reporting initialization",
    (content) =>
      content
        .replace(
          /^if \(import\.meta\.env\.VITE_SENTRY_DSN\) \{\n[\s\S]*?\n\}\n/m,
          `// ${MARKER}: browser error reporting removed.\n`,
        )
        .replace(/^import \{ init \} from "@sentry\/solid"\r?\n/m, ""),
    changes,
  )

  for (const file of [APP_VITE, DESKTOP_VITE]) {
    update(
      root,
      file,
      "prevent Sentry build plugin initialization even when upload secrets exist",
      (content) => {
        if (content.includes("const sentry = false") && !/sentryVitePlugin\s*\(\s*\{/.test(content)) return content
        // Apply both transformations in a single pass so one run from pristine reaches
        // the final state; the static import form needs the declaration rewritten too.
        let result = content.replace(
          /^import \{ sentryVitePlugin \} from "@sentry\/vite-plugin"\r?\n/m,
          `// ${MARKER}\nconst sentryVitePlugin = (..._args: unknown[]) => false\n`,
        )
        const rewritten = result.replace(
          /^const sentry =\n[\s\S]*?\n    : false\r?\n/m,
          `// ${MARKER}\nconst sentry = false\n`,
        )
        if (rewritten === result && !/^const sentry = false$/m.test(result))
          fail(`${file}: unrecognized Sentry plugin declaration; refusing to guess`)
        result = rewritten
        if (/sentryVitePlugin\s*\(\s*\{/.test(result)) fail(`${file}: Sentry build plugin is still constructed`)
        return result
      },
      changes,
    )
  }

  update(
    root,
    DESKTOP_SENTRY,
    "replace desktop Sentry startup with a no-op",
    (content) => {
      if (content.includes(MARKER) && content.includes("desktopVersion") && !content.includes("@sentry/")) return content
      return `// ${MARKER}
import pkg from "../../../package.json"

export function desktopVersion() {
  return import.meta.env.OPENCODE_VERSION ?? pkg.version
}

export async function initializeSentry(_version: string) {
  return undefined
}
`
    },
    changes,
  )

  if (exists(root, OTLP_TEST)) {
    update(
      root,
      OTLP_TEST,
      "invert the upstream OTLP export test: release builds must never export spans",
      () => `import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Otlp } from "../src/observability/otlp.js"

// ${MARKER}: this derivative must not create OTLP exporters.
test("tracingLayer never exports spans even when an endpoint is configured", async () => {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      return Response.json({})
    },
  })

  try {
    await Effect.gen(function* () {
      const tracing = yield* Otlp.tracingLayer(
        { endpoint: server.url.origin, headers: "x-otel-test=present" },
        { client: "test", version: "1.0.0", channel: "local" },
      )
      yield* Effect.void.pipe(Effect.withSpan("otlp-smoke"), Effect.provide(tracing))
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(requests).toHaveLength(0)
  } finally {
    server.stop(true)
  }
})

test("loggers never create an OTLP logger even when an endpoint is configured", () => {
  expect(Otlp.loggers({ endpoint: "http://127.0.0.1:1" }, { client: "test", version: "1.0.0", channel: "local" })).toEqual(
    [],
  )
})
`,
      changes,
    )
  }
}

/**
 * Verify behavior, not markers. Any reintroduced exporter capability is an error,
 * including inside a file that still carries the marker comment.
 */
export function verifyTelemetryDisabled(root: string) {
  const errors: string[] = []

  if (!fs.existsSync(root)) return [`${root}: checkout does not exist`]
  if (!fs.existsSync(resolveTarget(root, "packages/cli/package.json")))
    return [`${root}: not an OpenCode checkout (missing packages/cli/package.json)`]

  for (const file of REQUIRED) {
    if (!exists(root, file)) errors.push(`${file}: required file is missing`)
  }
  if (errors.length > 0) return errors

  const otlp = read(root, OTLP)
  for (const capability of ["OTLPTraceExporter", "OtlpLogger", "/v1/traces", "/v1/logs"]) {
    if (otlp.includes(capability)) errors.push(`${OTLP}: ${capability} remains`)
  }
  if (!/export function loggers\([^)]*\)\s*\{\s*return \[\]\s*\}/.test(otlp))
    errors.push(`${OTLP}: loggers() is not a verified no-op`)
  if (!/export const tracingLayer = Effect\.fnUntraced\(function\* \([^)]*\) \{\s*return Layer\.empty\s*\}/.test(otlp))
    errors.push(`${OTLP}: tracingLayer() is not a verified no-op`)

  const observability = read(root, OBSERVABILITY)
  if (!observability.includes("Logging.loggers(")) errors.push(`${OBSERVABILITY}: local logging is not preserved`)
  for (const capability of ["Otlp.", "OtlpSerialization", "OtlpExporter", "FetchHttpClient", "OTLPTraceExporter"]) {
    if (observability.includes(capability)) errors.push(`${OBSERVABILITY}: ${capability} remains in the layer`)
  }
  if (!/return local\b/.test(observability)) errors.push(`${OBSERVABILITY}: layer() does not return local logging`)

  const entry = read(root, APP_ENTRY)
  if (entry.includes("VITE_SENTRY_DSN")) errors.push(`${APP_ENTRY}: Sentry initialization remains`)
  if (/from\s+["']@sentry\//.test(entry)) errors.push(`${APP_ENTRY}: Sentry import remains`)

  for (const file of [APP_VITE, DESKTOP_VITE]) {
    const content = read(root, file)
    if (/from\s+["']@sentry\//.test(content)) errors.push(`${file}: Sentry import remains`)
    if (/import\(\s*["']@sentry\//.test(content)) errors.push(`${file}: dynamic Sentry import remains`)
    if (/sentryVitePlugin\s*\(\s*\{/.test(content) && !/sentryVitePlugin\s*=\s*\(\.\.\._args/.test(content))
      errors.push(`${file}: Sentry build plugin is still constructed`)
  }

  const desktop = read(root, DESKTOP_SENTRY)
  if (desktop.includes("@sentry/")) errors.push(`${DESKTOP_SENTRY}: Sentry import remains`)
  if (!desktop.includes("desktopVersion")) errors.push(`${DESKTOP_SENTRY}: required desktopVersion export was dropped`)
  if (!/export async function initializeSentry\([^)]*\)\s*\{\s*return undefined\s*\}/.test(desktop))
    errors.push(`${DESKTOP_SENTRY}: initializeSentry is not a verified no-op`)

  return errors
}

export function stripTelemetry(root: string) {
  if (!exists(root, "packages/cli/package.json")) fail(`not an OpenCode checkout: ${root}`)
  const changes: Change[] = []
  disableOtlp(root, changes)
  disableSentry(root, changes)
  return changes
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".")

  try {
    if (!exists(root, "packages/cli/package.json")) fail(`not an OpenCode checkout: ${root}`)
    if (!check) {
      const changes = stripTelemetry(root)
      for (const change of changes) console.log(`patched ${change.file}: ${change.reason}`)
      if (changes.length === 0) console.log("no changes needed (already patched)")
    }
    const errors = verifyTelemetryDisabled(root)
    if (errors.length > 0) {
      console.error("Telemetry verification failed:")
      for (const error of errors) console.error(`- ${error}`)
      process.exit(1)
    }
    console.log("telemetry verification passed")
  } catch (error) {
    console.error(`telemetry patch failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
