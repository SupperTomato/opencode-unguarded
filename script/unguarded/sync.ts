#!/usr/bin/env bun

/**
 * Regenerate the reviewed payloads and fingerprints from the working checkout.
 *
 * The derivative checkout is the source of truth for reviewed output. This
 * command copies every declared file into `patches/<version>/`, recomputes its
 * `final` digest, and verifies the `pristine` digest against the pinned upstream
 * worktree so a fingerprint can never describe the wrong input.
 *
 * Usage: bun script/unguarded/sync.ts [--version 2.1.2] [--upstream DIR] [--check]
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { loadManifest, manifestPath, repoRoot, validateManifest, type Manifest } from "./lib/patch"

const args = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const check = args.includes("--check")
const version = option("version") ?? "2.1.2"
const upstream = option("upstream") ?? process.env.UNGUARDED_UPSTREAM
const root = repoRoot()
// Load through the validator, but edit the raw document so fields the typed
// view does not carry (the derivative revision, injection notes, telemetry
// metadata) are preserved verbatim.
const raw: Record<string, unknown> = JSON.parse(fs.readFileSync(manifestPath(version), "utf8"))
const manifest = loadManifest(version)
const patchDir = path.join(root, "patches", version)

if (!upstream) {
  console.error("sync: pass --upstream <pristine checkout> or set UNGUARDED_UPSTREAM")
  process.exit(2)
}

const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
void (manifest satisfies Manifest)
const problems: string[] = []
const updated: Manifest["files"] = []

for (const entry of manifest.files) {
  const source = path.join(root, entry.file)
  const pristineFile = path.join(upstream, entry.file)
  if (!fs.existsSync(source)) {
    problems.push(`${entry.file}: missing from the derivative checkout`)
    continue
  }
  if (entry.pristine === null) {
    if (fs.existsSync(pristineFile)) problems.push(`${entry.file}: declared as added but exists upstream`)
  } else {
    if (!fs.existsSync(pristineFile)) {
      problems.push(`${entry.file}: missing from the upstream checkout`)
    } else if (digest(pristineFile) !== entry.pristine) {
      problems.push(`${entry.file}: upstream bytes do not match the recorded pristine digest`)
    }
  }
  const final = digest(source)
  const payload = path.join(patchDir, entry.file)
  if (!check) {
    fs.mkdirSync(path.dirname(payload), { recursive: true })
    fs.copyFileSync(source, payload)
  } else if (!fs.existsSync(payload) || digest(payload) !== final) {
    problems.push(`${entry.file}: payload is out of date`)
  }
  updated.push({ ...entry, final })
}

for (const entry of manifest.protected) {
  const pristineFile = path.join(upstream, entry.file)
  if (!fs.existsSync(pristineFile)) {
    problems.push(`${entry.file}: protected file missing from upstream`)
    continue
  }
  const expected = digest(pristineFile)
  if (expected !== entry.sha256) problems.push(`${entry.file}: upstream bytes do not match the protected digest`)
  const current = path.join(root, entry.file)
  if (fs.existsSync(current) && digest(current) !== entry.sha256)
    problems.push(`${entry.file}: protected file differs in the derivative checkout`)
}

if (problems.length > 0) {
  console.error("sync: refusing to update a manifest whose inputs do not match:")
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}

if (check) {
  console.log(`sync: ${updated.length} payloads and fingerprints are current`)
  process.exit(0)
}

const output = { ...raw, files: updated }
// Re-validate what is about to be written, so a sync can never emit a manifest
// the toolchain would reject.
validateManifest(output)
fs.writeFileSync(manifestPath(version), JSON.stringify(output, null, 2) + "\n")
console.log(`sync: updated ${updated.length} reviewed payloads and fingerprints`)
