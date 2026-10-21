#!/usr/bin/env bun

/**
 * One validation path for local builds, pull requests, and release builds.
 *
 * Usage: bun script/unguarded/validate.ts [--version 2.1.2] [--upstream DIR] [--binary FILE]
 *
 * Without --upstream, validation runs only the checks that need no second
 * checkout, and reports the source-identity checks as blocked rather than
 * silently skipping them. Pass --release to make any blocked check fatal; the
 * release workflow always does.
 */

import fs from "node:fs"
import path from "node:path"
import { apply, loadManifest, repoRoot, sha256, verify } from "./apply"
import { verifyTelemetryBinary, verifyTelemetrySource } from "./telemetry"
import { verifyLifecycle } from "./lifecycle"

type Result = { readonly id: string; readonly status: "pass" | "fail" | "blocked"; readonly detail?: string }

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}

const version = option("version") ?? "2.1.2"
const upstream = option("upstream")
const binary = option("binary")
const release = args.includes("--release")
const root = option("root") ? path.resolve(option("root")!) : repoRoot()
const manifest = loadManifest(version)
const results: Result[] = []

function check(id: string, run: () => string | undefined) {
  try {
    const detail = run()
    results.push({ id, status: "pass", detail })
  } catch (error) {
    results.push({ id, status: "fail", detail: (error as Error).message })
  }
}

function blocked(id: string, detail: string) {
  results.push({ id, status: "blocked", detail })
}

check("A1-patched-tree", () => {
  const errors = verify(root, manifest)
  if (errors.length > 0) throw new Error(errors.join("; "))
  return `${manifest.files.length} patched files and ${manifest.protected.length} protected files verified`
})

check("A2-lifecycle", () => {
  const errors = verifyLifecycle(root, manifest)
  if (errors.length > 0) throw new Error(errors.join("; "))
  return "updater boundary, service ownership, and derivative removal verified"
})

check("A3-telemetry-source", () => {
  const errors = verifyTelemetrySource(root)
  if (errors.length > 0) throw new Error(errors.join("; "))
  return "OTLP and Sentry integrations are absent from source"
})

if (binary) {
  check("A4-telemetry-binary", () => {
    const errors = verifyTelemetryBinary(binary)
    if (errors.length > 0) throw new Error(errors.join("; "))
    return `${path.basename(binary)} contains no exporter or Sentry capability`
  })
} else {
  blocked("A4-telemetry-binary", "no --binary given; runtime collector evidence is still required")
}

if (upstream) {
  check("B1-pristine-identity", () => {
    if (!fs.existsSync(path.join(upstream, "packages/cli/package.json")))
      throw new Error(`not an upstream checkout: ${upstream}`)
    const mismatched = manifest.files.filter((entry) => {
      if (entry.pristine === null) return false
      const file = path.join(upstream, entry.file)
      return !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== entry.pristine
    })
    if (mismatched.length > 0) throw new Error(`pristine mismatch: ${mismatched.map((entry) => entry.file).join(", ")}`)
    return `${manifest.files.length} pristine fingerprints match`
  })

  check("B2-apply-from-pristine", () => {
    const staged = fs.mkdtempSync(path.join(path.dirname(upstream), "unguarded-validate-"))
    try {
      for (const entry of [...manifest.files, ...manifest.protected]) {
        if ("pristine" in entry && entry.pristine === null) continue
        const source = path.join(upstream, entry.file)
        const target = path.join(staged, entry.file)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(source, target)
      }
      fs.mkdirSync(path.join(staged, "packages/cli"), { recursive: true })
      fs.copyFileSync(path.join(upstream, "packages/cli/package.json"), path.join(staged, "packages/cli/package.json"))
      fs.mkdirSync(path.join(staged, ".git"), { recursive: true })
      fs.writeFileSync(path.join(staged, ".git", "HEAD"), `${manifest.upstream.commit}\n`)
      apply(staged, manifest)
      const errors = verify(staged, manifest)
      if (errors.length > 0) throw new Error(errors.join("; "))
      return "pristine input produced the reviewed final bytes"
    } finally {
      fs.rmSync(staged, { recursive: true, force: true })
    }
  })
} else {
  blocked("B1-pristine-identity", "no --upstream given; run with a checkout pinned to the manifest commit")
  blocked("B2-apply-from-pristine", "no --upstream given; run with a checkout pinned to the manifest commit")
}

for (const result of results) {
  console.log(`${result.status.toUpperCase().padEnd(7)} ${result.id}${result.detail ? `: ${result.detail}` : ""}`)
}

const failed = results.filter((result) => result.status === "fail")
const blockedChecks = results.filter((result) => result.status === "blocked")
console.log(`\n${results.length - failed.length - blockedChecks.length} passed, ${failed.length} failed, ${blockedChecks.length} blocked`)
if (failed.length > 0 || (release && blockedChecks.length > 0)) process.exit(1)
