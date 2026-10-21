#!/usr/bin/env bun

/**
 * Telemetry verification for the derivative.
 *
 * Source correctness is established by content identity: `apply.ts` writes the
 * reviewed final bytes and the manifest pins their SHA-256. This module adds
 * behavioral invariants that must hold even if the reviewed sources change, and
 * verifies a packaged binary exposes no exporter capability or Sentry wiring.
 */

import fs from "node:fs"
import path from "node:path"
import { cliRoot, exists, loadManifest, positional, read, type Manifest } from "./lib/patch"

export type Change = { file: string; reason: string }

const OTLP = "packages/util/src/observability/otlp.ts"
const OBSERVABILITY = "packages/util/src/observability.ts"
const APP_ENTRY = "packages/app/src/entry.tsx"
const APP_VITE = "packages/app/vite.config.ts"
const DESKTOP_VITE = "packages/desktop/electron.vite.config.ts"
const DESKTOP_SENTRY = "packages/desktop/src/renderer/startup/sentry.ts"

// Capability markers, not every occurrence of a name. Effect's own runtime
// bundle still declares the unused `OtlpLogger`/`OtlpExporter` exports and the
// `/v1/logs` literal inside its dead Otlp module, and keeps
// "@effect/opentelemetry" as an unused specifier; nothing imports that module
// after this patch. The markers below identify real exporter construction and
// Sentry wiring, and the runtime collector harness proves the dead module is
// never reached.
const BANNED = [
  "OTLPTraceExporter",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-logs",
  "@sentry/solid",
  "@sentry/vite-plugin",
  "VITE_SENTRY_DSN",
  "sentryVitePlugin",
]

/** Invariants that must hold in source regardless of how the bytes got there. */
export function verifyTelemetrySource(root: string) {
  const errors: string[] = []

  for (const file of [OTLP, OBSERVABILITY, APP_ENTRY, APP_VITE, DESKTOP_VITE, DESKTOP_SENTRY]) {
    if (!exists(root, file)) errors.push(`${file}: required file is missing`)
  }
  if (errors.length > 0) return errors

  const otlp = read(root, OTLP)
  for (const capability of ["OTLPTraceExporter", "OtlpLogger", "/v1/traces", "/v1/logs"]) {
    if (otlp.includes(capability)) errors.push(`${OTLP}: ${capability} remains`)
  }
  if (!/^export function loggers\([^)]*\) \{\n  return \[\]\n\}$/m.test(otlp))
    errors.push(`${OTLP}: loggers() is not a no-op`)
  if (!/^export const tracingLayer = Effect\.fnUntraced\(function\* \([^)]*\) \{\n  return Layer\.empty\n\}\)$/m.test(otlp))
    errors.push(`${OTLP}: tracingLayer() is not a no-op`)
  if (/import\(\s*["']@opentelemetry\//.test(otlp)) errors.push(`${OTLP}: an OpenTelemetry import remains`)

  const observability = read(root, OBSERVABILITY)
  if (!observability.includes("Logging.loggers(")) errors.push(`${OBSERVABILITY}: local logging is not preserved`)
  for (const capability of ["Otlp.", "OtlpSerialization", "OtlpExporter", "FetchHttpClient", "OTLPTraceExporter"]) {
    if (observability.includes(capability)) errors.push(`${OBSERVABILITY}: ${capability} remains in the layer`)
  }
  if (!/return local\b/.test(observability)) errors.push(`${OBSERVABILITY}: layer() does not return local logging`)
  if (/Layer\.unwrap\(/.test(observability)) errors.push(`${OBSERVABILITY}: layer() still unwraps a telemetry layer`)

  const entry = read(root, APP_ENTRY)
  if (entry.includes("VITE_SENTRY_DSN") || /@sentry\//.test(entry))
    errors.push(`${APP_ENTRY}: Sentry initialization remains`)

  for (const file of [APP_VITE, DESKTOP_VITE]) {
    const content = read(root, file)
    if (/@sentry\//.test(content)) errors.push(`${file}: Sentry import remains`)
    if (/sentryVitePlugin\s*\(/.test(content)) errors.push(`${file}: Sentry build plugin is still constructed`)
  }

  const desktop = read(root, DESKTOP_SENTRY)
  if (/@sentry\//.test(desktop)) errors.push(`${DESKTOP_SENTRY}: Sentry import remains`)
  if (!desktop.includes("desktopVersion")) errors.push(`${DESKTOP_SENTRY}: required desktopVersion export was dropped`)
  if (!/^export async function initializeSentry\([^)]*\) \{\n  return undefined\n\}$/m.test(desktop))
    errors.push(`${DESKTOP_SENTRY}: initializeSentry is not a no-op`)

  return errors
}

/** Scan a packaged executable for telemetry capability. */
export function verifyTelemetryBinary(binary: string) {
  if (!fs.existsSync(binary)) return [`${binary}: executable does not exist`]
  const bytes = fs.readFileSync(binary)
  const errors: string[] = []
  for (const token of BANNED) {
    if (bytes.includes(Buffer.from(token))) errors.push(`${path.basename(binary)}: ${token} remains`)
  }
  return errors
}

export function verifyTelemetryDisabled(root: string, manifest: Manifest = loadManifest("2.1.2")) {
  const errors = verifyTelemetrySource(root)
  for (const entry of manifest.files) {
    if (!entry.file.startsWith("packages/util/") && !entry.file.startsWith("packages/app/") && !entry.file.startsWith("packages/desktop/"))
      continue
    if (!exists(root, entry.file)) errors.push(`${entry.file}: required file is missing`)
  }
  return errors
}

export function stripTelemetry(_root: string): Change[] {
  throw new Error("telemetry patches are applied by script/unguarded/apply.ts; run it with the pinned version instead")
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const binaryIndex = args.indexOf("--binary")
  const binary = binaryIndex === -1 ? undefined : args[binaryIndex + 1]
  const positionalArgs = positional(args, ["--root", "--binary"])
  const version = positionalArgs.find((arg) => /^\d+\.\d+\.\d+$/.test(arg))
  try {
    if (!args.includes("--check")) {
      console.error("telemetry patches are applied by script/unguarded/apply.ts; re-run with --check to verify")
      process.exit(2)
    }
    const rootIndex = positionalArgs.findIndex((arg) => !/^\d+\.\d+\.\d+$/.test(arg))
    const root = rootIndex === -1 ? cliRoot(args) : path.resolve(positionalArgs[rootIndex]!)
    const errors = binary === undefined ? verifyTelemetrySource(root) : verifyTelemetryBinary(binary)
    if (binary === undefined && version !== undefined) {
      const manifest = loadManifest(version)
      for (const entry of manifest.files) {
        if (!exists(root, entry.file)) errors.push(`${entry.file}: required file is missing`)
      }
    }
    if (errors.length > 0) {
      console.error("Telemetry verification failed:")
      for (const error of errors) console.error(`- ${error}`)
      process.exit(1)
    }
    console.log(binary === undefined ? "telemetry source verification passed" : "telemetry binary verification passed")
  } catch (error) {
    console.error(`telemetry verification failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
