import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  verifyTelemetryBinary,
  verifyTelemetryDisabled,
  verifyTelemetrySource,
} from "../../script/unguarded/telemetry"
import { loadManifest } from "../../script/unguarded/apply"

const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")
const manifest = loadManifest("2.1.2")
const files = manifest.files
  .map((entry) => entry.file)
  .filter((file) => /^packages\/(util|app|desktop)\//.test(file))

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-telemetry-"))
  for (const file of files) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, file), target)
  }
  return root
}

function rewrite(root: string, file: string, transform: (content: string) => string) {
  const target = path.join(root, file)
  fs.writeFileSync(target, transform(fs.readFileSync(target, "utf8")))
}

describe("telemetry source invariants", () => {
  test("the checked-in source verifies clean", () => {
    expect(verifyTelemetryDisabled(repoRoot, manifest)).toEqual([])
  })

  test("an active exporter beneath retained comments is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability/otlp.ts", (content) =>
      `${content}\nconst exporter = new OTLPTraceExporter({ url: "/v1/traces" })\n`,
    )
    const errors = verifyTelemetrySource(root).join("\n")
    expect(errors).toMatch(/OTLPTraceExporter remains/)
    expect(errors).toMatch(/\/v1\/traces remains/)
  })

  test("a decoy no-op comment does not satisfy the logger check", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability/otlp.ts", (content) =>
      content.replace(
        /export function loggers\([^)]*\) \{\s*return \[\]\s*\}/,
        '// export function loggers(a, b) { return [] }\nexport function loggers(_options, _app) { return makeLoggers() }',
      ),
    )
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/loggers\(\) is not a no-op/)
  })

  test("restored OTLP layering in observability is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability.ts", (content) =>
      content.replace("return local", "return Layer.merge(local, Otlp.tracingLayer(options, app))"),
    )
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/Otlp\. remains/)
  })

  test("a lost local logging layer is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability.ts", (content) =>
      content.replace("Logging.loggers(", "someOtherLogger("),
    )
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/local logging is not preserved/)
  })

  test("a dynamic browser Sentry import is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/app/src/entry.tsx", (content) =>
      `${content}\nimport("@sentry/solid").then(({ init }) => init({ dsn: "x" }))\n`,
    )
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/Sentry initialization remains/)
  })

  test("an active Sentry plugin with a decoy stub is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/app/vite.config.ts", (content) =>
      `${content}\n// const sentryVitePlugin = (..._args) => false\nvoid sentryVitePlugin({})\n`,
    )
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/still constructed/)
  })

  test("desktop reporting with a retained marker is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/desktop/src/renderer/startup/sentry.ts", (content) =>
      content.replace("return undefined", 'await fetch("https://sentry.example")'),
    )
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/initializeSentry is not a no-op/)
  })

  test("dropping desktopVersion is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/desktop/src/renderer/startup/sentry.ts", () => "export const nothing = 1\n")
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/desktopVersion export was dropped/)
  })

  test("a missing required file is reported", () => {
    const root = fixture()
    fs.rmSync(path.join(root, "packages/util/src/observability/otlp.ts"))
    expect(verifyTelemetrySource(root).join("\n")).toMatch(/required file is missing/)
  })
})

describe("telemetry binary verification", () => {
  test("rejects a binary containing exporter strings", () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-binary-"))
    const binary = path.join(directory, "opencode")
    fs.writeFileSync(binary, "hello OTLPTraceExporter VITE_SENTRY_DSN @sentry/solid")
    const errors = verifyTelemetryBinary(binary).join("\n")
    expect(errors).toMatch(/OTLPTraceExporter/)
    expect(errors).toMatch(/VITE_SENTRY_DSN/)
    expect(errors).toMatch(/@sentry\/solid/)
  })

  test("accepts a binary with none of the banned tokens", () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-binary-"))
    const binary = path.join(directory, "opencode")
    fs.writeFileSync(binary, "opencode-unguarded no restrictions")
    expect(verifyTelemetryBinary(binary)).toEqual([])
  })

  test("reports a missing binary", () => {
    expect(verifyTelemetryBinary("/tmp/definitely-not-a-binary-xyz").join("\n")).toMatch(/does not exist/)
  })
})
