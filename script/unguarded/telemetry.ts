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

function exists(root: string, file: string) {
  return fs.existsSync(path.join(root, file))
}

function read(root: string, file: string) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function update(root: string, file: string, reason: string, transform: (content: string) => string, changes: Change[]) {
  if (!exists(root, file)) return false
  const before = read(root, file)
  const after = transform(before)
  if (after === before) return false
  fs.writeFileSync(path.join(root, file), after)
  changes.push({ file, reason })
  return true
}

function replaceFunctionBody(content: string, name: string, body: string) {
  const signature = new RegExp(`export\\s+(?:async\\s+)?(?:const|function)\\s+${name}\\s*[=(][^{]*\\{`, "m")
  const match = signature.exec(content)
  if (!match) throw new Error(`Unable to locate ${name}() while disabling OTLP`)
  const open = match.index + match[0].lastIndexOf("{")
  let depth = 0
  for (let index = open; index < content.length; index++) {
    if (content[index] === "{") depth++
    if (content[index] !== "}") continue
    depth--
    if (depth !== 0) continue
    return content.slice(0, open + 1) + body + content.slice(index)
  }
  throw new Error(`Unable to find the end of ${name}() while disabling OTLP`)
}

function disableOtlp(root: string, changes: Change[]) {
  if (!exists(root, OTLP)) throw new Error(`${OTLP}: observability module not found; refusing to guess`)

  update(
    root,
    OTLP,
    "replace OTLP logger and trace exporter with no-ops while retaining resource helpers",
    (content) => {
      if (content.includes(MARKER)) return content
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
        result = result.replace(/^import \{ Effect, Layer, Scope \} from "effect"$/m, 'import { Effect, Layer } from "effect"')
      result = result.replace(
        /^function parseHeaders\(value\?: string\) \{\n[\s\S]*?\n\}\r?\n\r?\n/m,
        "",
      )
      const anchor = "function resourceAttributes()"
      if (!result.includes(anchor)) throw new Error(`${OTLP}: resource helper missing; refusing to modify`)
      result = result.replace(
        anchor,
        `// ${MARKER}. Resource construction remains for API compatibility,\n// but no logger or trace exporter can be created by release binaries.\n${anchor}`,
      )
      for (const value of ["OTLPTraceExporter", "OtlpLogger", "/v1/traces", "/v1/logs"]) {
        if (result.includes(value)) throw new Error(`${OTLP}: failed to remove exporter capability (${value})`)
      }
      return result
    },
    changes,
  )

  if (exists(root, OBSERVABILITY) && !read(root, OBSERVABILITY).includes("Logging.loggers(")) {
    throw new Error(`${OBSERVABILITY}: local logging layer missing; refusing to strip observability`)
  }

  update(
    root,
    OBSERVABILITY,
    "remove OTLP logger, serialization, exporter, and tracing layers; keep local logging",
    (content) => {
      if (content.includes(MARKER)) return content
      let result = content.replace(/^import \{ FetchHttpClient \} from "effect\/http"\r?\n/m, "")
      result = result.replace(/^import \{ OtlpExporter, OtlpSerialization \} from "effect\/observability"\r?\n/m, "")
      result = result.replace(/^import \{ Otlp \} from "\.\/observability\/otlp\.js"\r?\n/m, "")
      const replaced = result.replace(
        /  return Layer\.unwrap\(\n[\s\S]*?\)\.pipe\(Layer\.catchCause\(\(\) => local\)\)\n/m,
        `  // ${MARKER}: only local logging is installed.\n  return local\n`,
      )
      if (replaced === result) throw new Error(`${OBSERVABILITY}: layer() shape changed; refusing to guess`)
      result = replaced
      if (!result.includes("Effect.")) result = result.replace(/^import \{ Effect, Layer, Logger, References, Schema \} from "effect"$/m, 'import { Layer, Logger, References, Schema } from "effect"')
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
        const replaced = content.replace(
          /^import \{ sentryVitePlugin \} from "@sentry\/vite-plugin"\r?\n/m,
          `// ${MARKER}\nconst sentryVitePlugin = (..._args: unknown[]) => false\n`,
        )
        if (replaced !== content) return replaced
        return content.replace(/^const sentry =\n[\s\S]*?\n    : false\r?\n/m, `// ${MARKER}\nconst sentry = false\n`)
      },
      changes,
    )
  }

  update(
    root,
    DESKTOP_SENTRY,
    "replace desktop Sentry startup with a no-op",
    (content) => {
      if (content.includes(MARKER)) return content
      return `// ${MARKER}
export async function initializeSentry(_version: string) {
  return undefined
}
`
    },
    changes,
  )

  update(
    root,
    "packages/util/test/observability-otlp.test.ts",
    "invert the upstream OTLP export test: release builds must never export spans",
    (content) => {
      if (content.includes(MARKER)) return content
      return `import { expect, test } from "bun:test"
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
`
    },
    changes,
  )
}

export function verifyTelemetryDisabled(root: string) {
  const errors: string[] = []

  if (exists(root, OTLP)) {
    const content = read(root, OTLP)
    for (const marker of ["OTLPTraceExporter", "OtlpLogger", "/v1/traces", "/v1/logs"]) {
      if (content.includes(marker)) errors.push(`${OTLP}: ${marker} remains`)
    }
    if (!/export function loggers\([^)]*\)\s*\{\s*return \[\]\s*\}/.test(content))
      errors.push(`${OTLP}: loggers() is not a verified no-op`)
    if (!/export const tracingLayer = Effect\.fnUntraced\(function\* \([^)]*\) \{\s*return Layer\.empty\s*\}/.test(content))
      errors.push(`${OTLP}: tracingLayer() is not a verified no-op`)
  }

  if (exists(root, OBSERVABILITY) && !read(root, OBSERVABILITY).includes("Logging.loggers("))
    errors.push(`${OBSERVABILITY}: local logging is not preserved`)

  if (exists(root, APP_ENTRY) && read(root, APP_ENTRY).includes("VITE_SENTRY_DSN"))
    errors.push(`${APP_ENTRY}: Sentry initialization remains`)

  for (const file of [APP_VITE, DESKTOP_VITE]) {
    if (!exists(root, file)) continue
    const content = read(root, file)
    if (/^import \{ sentryVitePlugin \} from "@sentry\/vite-plugin"/m.test(content))
      errors.push(`${file}: Sentry build plugin import remains`)
  }

  if (exists(root, DESKTOP_SENTRY) && read(root, DESKTOP_SENTRY).includes("@sentry/"))
    errors.push(`${DESKTOP_SENTRY}: Sentry import remains`)

  return errors
}

export function stripTelemetry(root: string) {
  if (!exists(root, "packages/cli/package.json")) throw new Error(`Not an OpenCode checkout: ${root}`)
  const changes: Change[] = []
  disableOtlp(root, changes)
  disableSentry(root, changes)
  return changes
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const root = path.resolve(args.find((arg) => !arg.startsWith("--")) ?? ".")

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
}
