#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"

export type Manifest = {
  upstream: {
    repository: string
    version: string
    tag: string
    commit: string
    npmPackage: string
    npmIntegrity: string
    publishedAt: string
    resolvedAt: string
  }
  injection: {
    line: string
    position: "line-2"
    appliesTo: string[]
  }
  removals: Array<{
    id: string
    file: string
    reason: string
    match: string
    count: number
    action: "delete-line" | "replace-with-empty" | "replace"
    replacement?: string
  }>
  preserved: string[]
  telemetry: { targets: string[]; preserve: string[] }
}

export type Change = {
  id: string
  file: string
  action: string
}

function manifestPath(version: string) {
  return path.join(import.meta.dir, "..", "..", "manifests", `${version}.json`)
}

export function loadManifest(version: string): Manifest {
  const file = manifestPath(version)
  if (!fs.existsSync(file)) throw new Error(`No manifest for upstream ${version}: ${file}`)
  return JSON.parse(fs.readFileSync(file, "utf8")) as Manifest
}

function read(root: string, file: string) {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) throw new Error(`Missing file: ${file}`)
  return fs.readFileSync(full, "utf8")
}

function write(root: string, file: string, content: string) {
  fs.writeFileSync(path.join(root, file), content)
}

function occurrences(haystack: string, needle: string) {
  if (needle.length === 0) return 0
  let total = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    total++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return total
}

function alreadyApplied(content: string, injection: string) {
  return content.includes(injection)
}

function fullyApplied(content: string, manifest: Manifest, file: string) {
  const injected = manifest.injection.appliesTo.includes(file)
  if (injected && !alreadyApplied(content, manifest.injection.line)) return false
  for (const removal of manifest.removals) {
    if (removal.file !== file) continue
    if (removal.action === "replace") continue
    if (content.includes(removal.match)) return false
  }
  return true
}

function deleteLine(content: string, line: string) {
  const lines = content.split("\n")
  const index = lines.indexOf(line)
  if (index === -1) throw new Error(`Anchor line not found: ${line.slice(0, 60)}`)
  lines.splice(index, 1)
  return lines.join("\n")
}

function applyRemoval(content: string, removal: Manifest["removals"][number]) {
  const seen = occurrences(content, removal.match)
  if (seen !== removal.count) {
    throw new Error(`${removal.id}: expected ${removal.count} match(es), found ${seen}`)
  }
  switch (removal.action) {
    case "delete-line":
      return deleteLine(content, removal.match)
    case "replace-with-empty":
      return content.split(removal.match).join("")
    case "replace": {
      if (removal.replacement === undefined) throw new Error(`${removal.id}: replacement text is required`)
      return content.split(removal.match).join(removal.replacement)
    }
  }
}

function inject(content: string, line: string) {
  const lines = content.split("\n")
  if (lines[1] === line) return content
  lines.splice(1, 0, line)
  return lines.join("\n")
}

export type Plan = {
  file: string
  next: string
  changes: Change[]
}

export function plan(root: string, manifest: Manifest): Plan[] {
  const plans: Plan[] = []
  const grouped = new Map<string, Manifest["removals"]>()
  for (const removal of manifest.removals) {
    const list = grouped.get(removal.file) ?? []
    list.push(removal)
    grouped.set(removal.file, list)
  }
  const files = new Set<string>([...grouped.keys(), ...manifest.injection.appliesTo])
  for (const file of files) {
    const before = read(root, file)
    if (fullyApplied(before, manifest, file)) {
      plans.push({ file, next: before, changes: [] })
      continue
    }
    if (alreadyApplied(before, manifest.injection.line)) {
      throw new Error(`${file}: partially patched (directive present but removal anchors still match); refusing to continue`)
    }
    let after = before
    const changes: Change[] = []
    for (const removal of grouped.get(file) ?? []) {
      after = applyRemoval(after, removal)
      changes.push({ id: removal.id, file, action: removal.action })
    }
    if (manifest.injection.appliesTo.includes(file)) {
      after = inject(after, manifest.injection.line)
      changes.push({ id: "inject-unrestricted-line", file, action: "insert-line-2" })
    }
    plans.push({ file, next: after, changes })
  }
  return plans
}

export function apply(root: string, manifest: Manifest) {
  const plans = plan(root, manifest)
  const changed = plans.filter((item) => item.changes.length > 0)
  for (const item of changed) write(root, item.file, item.next)
  return changed.flatMap((item) => item.changes)
}

export function verify(root: string, manifest: Manifest) {
  const errors: string[] = []
  for (const file of manifest.injection.appliesTo) {
    const content = read(root, file)
    if (!content.includes(manifest.injection.line)) errors.push(`${file}: missing injected directive`)
    if (content.split("\n")[1] !== manifest.injection.line) errors.push(`${file}: directive is not on line 2`)
  }
  for (const removal of manifest.removals) {
    const content = read(root, removal.file)
    if (removal.action === "replace") continue
    if (content.includes(removal.match)) errors.push(`${removal.id}: anchor still present in ${removal.file}`)
  }
  return errors
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const version = args.find((arg) => !arg.startsWith("--"))
  if (!version) {
    console.error("usage: bun script/unguarded/apply.ts <upstream-version> [--root <dir>] [--check]")
    process.exit(2)
  }
  const rootIndex = args.indexOf("--root")
  const root = rootIndex === -1 ? process.cwd() : path.resolve(args[rootIndex + 1] ?? ".")
  const check = args.includes("--check")
  const manifest = loadManifest(version)

  if (!check) {
    const changes = apply(root, manifest)
    for (const change of changes) console.log(`patched ${change.file}: ${change.id}`)
    if (changes.length === 0) console.log("no changes needed (already patched)")
  }

  const errors = verify(root, manifest)
  if (errors.length > 0) {
    console.error("Guardrail verification failed:")
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log(`guardrail verification passed for upstream ${manifest.upstream.version} (${manifest.upstream.commit.slice(0, 8)})`)
}
