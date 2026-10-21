import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripTelemetry, verifyTelemetryDisabled } from "../../script/unguarded/telemetry"

const root = path.join(import.meta.dir, "..", "..")

describe("telemetry removal", () => {
  test("verified state has no telemetry findings", () => {
    expect(verifyTelemetryDisabled(root)).toEqual([])
  })

  test("OTLP loggers and tracers are no-ops", () => {
    const otlp = fs.readFileSync(path.join(root, "packages/util/src/observability/otlp.ts"), "utf8")
    expect(otlp).toMatch(/export function loggers\([^)]*\) \{\s*return \[\]\s*\}/)
    expect(otlp).toMatch(/export const tracingLayer = Effect\.fnUntraced\(function\* \([^)]*\) \{\s*return Layer\.empty\s*\}/)
  })

  test("observability layer installs only local logging", () => {
    const observability = fs.readFileSync(path.join(root, "packages/util/src/observability.ts"), "utf8")
    expect(observability).not.toContain("Otlp")
    expect(observability).not.toContain("OtlpSerialization")
    expect(observability).toContain("Logging.loggers(")
    expect(observability).toMatch(/return local/)
  })

  test("browser and desktop error reporting are disabled", () => {
    expect(fs.readFileSync(path.join(root, "packages/app/src/entry.tsx"), "utf8")).not.toContain("VITE_SENTRY_DSN")
    expect(fs.readFileSync(path.join(root, "packages/desktop/src/renderer/startup/sentry.ts"), "utf8")).not.toContain(
      "@sentry/",
    )
  })

  test("strip is idempotent", () => {
    expect(stripTelemetry(root)).toEqual([])
  })

  test("verifier detects a restored exporter", () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "telemetry-detect-"))
    for (const file of ["packages/util/src/observability/otlp.ts", "packages/util/src/observability.ts", "packages/cli/package.json"]) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
      fs.copyFileSync(path.join(root, file), path.join(dir, file))
    }
    const otlp = path.join(dir, "packages/util/src/observability/otlp.ts")
    fs.writeFileSync(otlp, `${fs.readFileSync(otlp, "utf8")}\nconst x = "/v1/traces"\n`)
    expect(verifyTelemetryDisabled(dir).length).toBeGreaterThan(0)
  })
})
