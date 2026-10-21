#!/usr/bin/env bun

import fs from "node:fs"
import path from "node:path"

export type Removal = {
  id: string
  file: string
  reason: string
  match: string
  count: number
  action: "delete-line" | "replace-with-empty" | "replace"
  replacement?: string
}

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
  removals: Removal[]
  preserved: string[]
  telemetry: { targets: string[]; preserve: string[] }
}

export type Change = {
  id: string
  file: string
  action: string
}

export type Plan = {
  file: string
  next: string
  changes: Change[]
}

const SEMVER = /^\d+\.\d+\.\d+$/
const SHA = /^[0-9a-f]{40}$/

function manifestPath(version: string) {
  return path.join(import.meta.dir, "..", "..", "manifests", `${version}.json`)
}

function fail(message: string): never {
  throw new Error(message)
}

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) fail(`manifest: ${label} must be a non-empty string`)
  return value
}

function assertArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length === 0) fail(`manifest: ${label} must be a non-empty array`)
  return value
}

/**
 * Validate manifest structure before it can influence any file operation.
 * A malformed manifest must never reach the planning stage.
 */
export function validateManifest(input: unknown): Manifest {
  if (typeof input !== "object" || input === null) fail("manifest: expected an object")
  const raw = input as Record<string, any>

  const upstream = raw.upstream
  if (typeof upstream !== "object" || upstream === null) fail("manifest: upstream is required")
  const version = assertString(upstream.version, "upstream.version")
  if (!SEMVER.test(version)) fail(`manifest: upstream.version is not semver: ${version}`)
  const commit = assertString(upstream.commit, "upstream.commit")
  if (!SHA.test(commit)) fail(`manifest: upstream.commit is not a 40-character SHA: ${commit}`)
  assertString(upstream.repository, "upstream.repository")
  assertString(upstream.tag, "upstream.tag")
  assertString(upstream.npmPackage, "upstream.npmPackage")
  assertString(upstream.npmIntegrity, "upstream.npmIntegrity")

  const injection = raw.injection
  if (typeof injection !== "object" || injection === null) fail("manifest: injection is required")
  const line = assertString(injection.line, "injection.line")
  if (line.includes("\n")) fail("manifest: injection.line must be a single line")
  if (injection.position !== "line-2") fail("manifest: injection.position must be \"line-2\"")
  const appliesTo = assertArray(injection.appliesTo, "injection.appliesTo") as string[]
  for (const file of appliesTo) assertRelativePath(file, "injection.appliesTo")

  const removals = assertArray(raw.removals, "removals") as Removal[]
  const ids = new Set<string>()
  for (const removal of removals) {
    if (typeof removal !== "object" || removal === null) fail("manifest: removal entries must be objects")
    const id = assertString(removal.id, "removals[].id")
    if (ids.has(id)) fail(`manifest: duplicate removal id: ${id}`)
    ids.add(id)
    assertRelativePath(assertString(removal.file, `${id}.file`), `${id}.file`)
    assertString(removal.reason, `${id}.reason`)
    const match = assertString(removal.match, `${id}.match`)
    if (!Number.isInteger(removal.count) || removal.count < 1) fail(`manifest: ${id}.count must be a positive integer`)
    if (!["delete-line", "replace-with-empty", "replace"].includes(removal.action))
      fail(`manifest: ${id}.action is not supported: ${removal.action}`)
    if (removal.action === "delete-line" && match.includes("\n"))
      fail(`manifest: ${id} uses delete-line but match spans multiple lines`)
    if (removal.action === "replace") {
      const replacement = assertString(removal.replacement, `${id}.replacement`)
      if (replacement === match) fail(`manifest: ${id}.replacement must differ from match`)
      if (replacement.includes(match)) fail(`manifest: ${id}.replacement must not contain the original text`)
    }
  }

  for (const file of appliesTo) {
    for (const removal of removals) {
      if (removal.file === file && removal.action === "replace-with-empty" && removal.match.trim().length === 0)
        fail(`manifest: ${removal.id} would blank a file containing the directive`)
    }
  }

  return {
    upstream: {
      repository: upstream.repository,
      version,
      tag: upstream.tag,
      commit,
      npmPackage: upstream.npmPackage,
      npmIntegrity: upstream.npmIntegrity,
      publishedAt: String(upstream.publishedAt ?? ""),
      resolvedAt: String(upstream.resolvedAt ?? ""),
    },
    injection: { line, position: "line-2", appliesTo },
    removals,
    preserved: Array.isArray(raw.preserved) ? raw.preserved : [],
    telemetry: raw.telemetry ?? { targets: [], preserve: [] },
  }
}

export function loadManifest(version: string): Manifest {
  if (!SEMVER.test(version)) fail(`invalid upstream version: ${version}`)
  const file = manifestPath(version)
  if (!fs.existsSync(file)) fail(`No manifest for upstream ${version}: ${file}`)
  return validateManifest(JSON.parse(fs.readFileSync(file, "utf8")))
}

/**
 * Reject absolute paths, traversal, and (when the target exists) symlinks that
 * resolve outside the source root. Containment is checked on the real path.
 */
function assertRelativePath(file: string, label: string) {
  if (path.isAbsolute(file)) fail(`manifest: ${label} must be relative: ${file}`)
  if (file.split(/[\\/]/).includes("..")) fail(`manifest: ${label} must not traverse: ${file}`)
  if (file.length === 0) fail(`manifest: ${label} must not be empty`)
}

export function resolveTarget(root: string, file: string) {
  assertRelativePath(file, file)
  const realRoot = fs.realpathSync(root)
  const candidate = path.resolve(realRoot, file)
  const parent = path.dirname(candidate)
  const realParent = fs.existsSync(parent) ? fs.realpathSync(parent) : parent
  const resolved = path.join(realParent, path.basename(candidate))
  const relative = path.relative(realRoot, resolved)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail(`refusing to touch a path outside the source root: ${file} -> ${resolved}`)
  return resolved
}

function read(root: string, file: string) {
  const full = resolveTarget(root, file)
  if (!fs.existsSync(full)) fail(`missing file: ${file}`)
  return fs.readFileSync(full, "utf8")
}

function write(root: string, file: string, content: string) {
  fs.writeFileSync(resolveTarget(root, file), content)
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

function deleteLine(content: string, line: string) {
  const lines = content.split("\n")
  const index = lines.indexOf(line)
  if (index === -1) fail(`anchor line not found: ${line.slice(0, 60)}`)
  lines.splice(index, 1)
  return lines.join("\n")
}

function applyRemoval(content: string, removal: Removal) {
  const seen = occurrences(content, removal.match)
  if (seen !== removal.count) fail(`${removal.id}: expected ${removal.count} match(es), found ${seen}`)
  switch (removal.action) {
    case "delete-line":
      return deleteLine(content, removal.match)
    case "replace-with-empty":
      return content.split(removal.match).join("")
    case "replace":
      return content.split(removal.match).join(removal.replacement!)
  }
}

function inject(content: string, line: string) {
  const lines = content.split("\n")
  lines.splice(1, 0, line)
  return lines.join("\n")
}

/** True only when the file is exactly the expected patched output. */
export function isPatched(content: string, manifest: Manifest, file: string) {
  const lines = content.split("\n")
  const injected = manifest.injection.appliesTo.includes(file)
  if (injected) {
    if (lines[1] !== manifest.injection.line) return false
    if (occurrences(content, manifest.injection.line) !== 1) return false
  }
  for (const removal of manifest.removals) {
    if (removal.file !== file) continue
    if (removal.action === "replace") {
      if (occurrences(content, removal.match) !== 0) return false
      if (occurrences(content, removal.replacement!) !== 1) return false
      continue
    }
    if (occurrences(content, removal.match) !== 0) return false
  }
  return true
}

/**
 * True only when the file is exactly the pristine supported input. Used to
 * distinguish "not yet patched" from "partially patched" without guessing.
 */
export function isPristine(content: string, manifest: Manifest, file: string) {
  const injected = manifest.injection.appliesTo.includes(file)
  if (injected && occurrences(content, manifest.injection.line) !== 0) return false
  for (const removal of manifest.removals) {
    if (removal.file !== file) continue
    if (removal.action === "replace") {
      if (occurrences(content, removal.match) !== 1) return false
      if (occurrences(content, removal.replacement!) !== 0) return false
      continue
    }
    if (occurrences(content, removal.match) !== 1) return false
  }
  return true
}

export function plan(root: string, manifest: Manifest): Plan[] {
  const grouped = new Map<string, Removal[]>()
  for (const removal of manifest.removals) {
    const list = grouped.get(removal.file) ?? []
    list.push(removal)
    grouped.set(removal.file, list)
  }
  const files = new Set<string>([...grouped.keys(), ...manifest.injection.appliesTo])
  const plans: Plan[] = []

  for (const file of files) {
    const before = read(root, file)
    if (isPatched(before, manifest, file)) {
      plans.push({ file, next: before, changes: [] })
      continue
    }
    if (!isPristine(before, manifest, file))
      fail(
        `${file}: neither pristine nor fully patched for upstream ${manifest.upstream.version}. ` +
          `Refusing to guess (partially patched, drifted, or unsupported source).`,
      )
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
    if (!isPatched(after, manifest, file)) fail(`${file}: computed output does not satisfy the manifest postcondition`)
    plans.push({ file, next: after, changes })
  }
  return plans
}

/** Compute and validate everything, then write. Any failure leaves the tree untouched. */
export function apply(root: string, manifest: Manifest) {
  const plans = plan(root, manifest)
  const changed = plans.filter((item) => item.changes.length > 0)
  for (const item of changed) write(root, item.file, item.next)
  return changed.flatMap((item) => item.changes)
}

export function verify(root: string, manifest: Manifest) {
  const errors: string[] = []
  const files = new Set<string>([...manifest.injection.appliesTo, ...manifest.removals.map((item) => item.file)])
  for (const file of files) {
    let content: string
    try {
      content = read(root, file)
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`)
      continue
    }
    if (!isPatched(content, manifest, file)) errors.push(`${file}: does not match the expected patched output`)
  }
  return errors
}

/**
 * Verify the checkout really is the pinned upstream revision, so a manifest
 * can never be applied to an unrelated tree.
 */
export function verifyUpstreamIdentity(root: string, manifest: Manifest) {
  const pkgFile = resolveTarget(root, "packages/cli/package.json")
  if (!fs.existsSync(pkgFile)) fail(`not an OpenCode checkout (missing packages/cli/package.json): ${root}`)
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { version?: string }
  if (pkg.version !== manifest.upstream.version)
    fail(
      `checkout version ${pkg.version ?? "<missing>"} does not match manifest ${manifest.upstream.version}; ` +
        `refusing to patch an unsupported source`,
    )
  return true
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

  try {
    verifyUpstreamIdentity(root, manifest)
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
    console.log(
      `guardrail verification passed for upstream ${manifest.upstream.version} (${manifest.upstream.commit.slice(0, 8)})`,
    )
  } catch (error) {
    console.error(`guardrail patch failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
