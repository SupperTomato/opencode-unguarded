#!/usr/bin/env bun

/**
 * Shared patch engine for the derivative.
 *
 * Every transformation is expressed as a pure function from the exact pinned
 * upstream text to the exact reviewed final text. The manifest records a
 * SHA-256 for both sides, so a tree is only ever accepted when it is wholly
 * pristine or wholly final. Anything else is rejected before a single byte is
 * written.
 */

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type FileFingerprint = {
  readonly pristine: string
  readonly final: string
}

export type ManifestFile = {
  readonly file: string
  /** SHA-256 of the upstream input, or null when the derivative adds the file. */
  readonly pristine: string | null
  readonly final: string
  readonly reason: string
}

export type ProtectedFile = {
  readonly file: string
  readonly sha256: string
  readonly reason: string
}

export type Removal = {
  readonly id: string
  readonly file: string
  readonly reason: string
  readonly match: string
  readonly count: number
  readonly action: "delete-line" | "replace-with-empty" | "replace"
  readonly replacement?: string
}

export type Manifest = {
  readonly schema: number
  readonly upstream: {
    readonly repository: string
    readonly version: string
    readonly tag: string
    readonly commit: string
    readonly npmPackage: string
    readonly npmIntegrity: string
    readonly publishedAt: string
    readonly resolvedAt: string
  }
  readonly injection: {
    readonly line: string
    readonly position: "line-2"
    readonly appliesTo: string[]
    readonly note: string
  }
  readonly removals: Removal[]
  readonly files: ManifestFile[]
  readonly protected: ProtectedFile[]
  readonly preserved: string[]
  readonly telemetry: { readonly targets: string[]; readonly preserve: string[] }
}

export type Change = { readonly file: string; readonly reason: string }
export type Planned = { readonly file: string; readonly next: string; readonly change: Change | undefined }

const SEMVER = /^\d+\.\d+\.\d+$/
const SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/

export function fail(message: string): never {
  throw new Error(message)
}

export function sha256(value: string | Uint8Array) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function repoRoot() {
  return path.resolve(import.meta.dir, "..", "..", "..")
}

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) fail(`manifest: ${label} must be a non-empty string`)
  return value
}

function assertDigest(value: unknown, label: string) {
  const text = assertString(value, label)
  if (!DIGEST.test(text)) fail(`manifest: ${label} must be a lowercase SHA-256: ${text}`)
  return text
}

export function assertRelativePath(file: string, label: string) {
  if (path.isAbsolute(file)) fail(`manifest: ${label} must be relative: ${file}`)
  if (file.split(/[\\/]/).includes("..")) fail(`manifest: ${label} must not traverse: ${file}`)
  if (file.length === 0) fail(`manifest: ${label} must not be empty`)
  const normal = path.posix.normalize(file)
  if (normal !== file) fail(`manifest: ${label} must be normalized: ${file}`)
  if (file.split("/").some((part) => part === "" || part === ".")) fail(`manifest: ${label} is not a plain path: ${file}`)
}

/**
 * Resolve a manifest path inside the source root.
 *
 * Containment is checked on the real path of every component, including the
 * final file, so a symlinked directory or file cannot redirect a write. Patch
 * targets are immutable build inputs; refusing links outright keeps the
 * relationship between a fingerprint and the bytes on disk unambiguous.
 */
export function resolveTarget(root: string, file: string) {
  assertRelativePath(file, file)
  const realRoot = fs.realpathSync(root)
  const candidate = path.resolve(realRoot, file)
  const relative = path.relative(realRoot, candidate)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    fail(`refusing to touch a path outside the source root: ${file} -> ${candidate}`)
  assertNoLinks(realRoot, relative, file)
  return candidate
}

function assertNoLinks(realRoot: string, relative: string, file: string) {
  const parts = relative.split(path.sep)
  let current = realRoot
  for (const part of parts) {
    current = path.join(current, part)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch {
      return
    }
    if (!stat.isSymbolicLink()) continue
    const resolved = fs.realpathSync(current)
    const inside = path.relative(realRoot, resolved)
    if (inside.startsWith("..") || path.isAbsolute(inside))
      fail(`refusing to follow a symlink outside the source root: ${file} -> ${current}`)
    fail(`refusing to patch a symlinked path: ${file} -> ${current}`)
  }
}

export function exists(root: string, file: string) {
  return fs.existsSync(resolveTarget(root, file))
}

export function read(root: string, file: string) {
  const full = resolveTarget(root, file)
  if (!fs.existsSync(full)) fail(`missing file: ${file}`)
  const stat = fs.lstatSync(full)
  if (!stat.isFile()) fail(`not a regular file: ${file}`)
  if (stat.nlink > 1) fail(`refusing to patch a hard-linked file: ${file}`)
  return fs.readFileSync(full, "utf8")
}

function write(root: string, file: string, content: string) {
  const full = resolveTarget(root, file)
  const temp = `${full}.unguarded-${process.pid}-${crypto.randomBytes(6).toString("hex")}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o644 })
  try {
    fs.renameSync(temp, full)
  } catch (error) {
    fs.rmSync(temp, { force: true })
    throw error
  }
}

export function occurrences(haystack: string, needle: string) {
  if (needle.length === 0) return 0
  let total = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    total++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return total
}

export function validateManifest(input: unknown): Manifest {
  if (typeof input !== "object" || input === null) fail("manifest: expected an object")
  const raw = input as Record<string, any>
  if (raw.schema !== 2) fail(`manifest: unsupported schema ${String(raw.schema)}; expected 2`)

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
  if (injection.position !== "line-2") fail('manifest: injection.position must be "line-2"')
  if (!Array.isArray(injection.appliesTo) || injection.appliesTo.length === 0)
    fail("manifest: injection.appliesTo must be a non-empty array")
  const appliesTo = injection.appliesTo.map((file: unknown) => {
    const value = assertString(file, "injection.appliesTo")
    assertRelativePath(value, "injection.appliesTo")
    return value
  })
  if (new Set(appliesTo).size !== appliesTo.length) fail("manifest: injection.appliesTo contains duplicates")

  if (!Array.isArray(raw.removals) || raw.removals.length === 0)
    fail("manifest: removals must be a non-empty array")
  const ids = new Set<string>()
  const removals: Removal[] = raw.removals.map((removal: any) => {
    if (typeof removal !== "object" || removal === null) fail("manifest: removal entries must be objects")
    const id = assertString(removal.id, "removals[].id")
    if (ids.has(id)) fail(`manifest: duplicate removal id: ${id}`)
    ids.add(id)
    const file = assertString(removal.file, `${id}.file`)
    assertRelativePath(file, `${id}.file`)
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
    return {
      id,
      file,
      reason: removal.reason,
      match,
      count: removal.count,
      action: removal.action,
      replacement: removal.action === "replace" ? removal.replacement : undefined,
    }
  })

  if (!Array.isArray(raw.files) || raw.files.length === 0) fail("manifest: files must be a non-empty array")
  const filePaths = new Set<string>()
  const files: ManifestFile[] = raw.files.map((entry: any) => {
    if (typeof entry !== "object" || entry === null) fail("manifest: files entries must be objects")
    const file = assertString(entry.file, "files[].file")
    assertRelativePath(file, "files[].file")
    if (filePaths.has(file)) fail(`manifest: duplicate file entry: ${file}`)
    filePaths.add(file)
    return {
      file,
      pristine: entry.pristine === null ? null : assertDigest(entry.pristine, `${file}.pristine`),
      final: assertDigest(entry.final, `${file}.final`),
      reason: assertString(entry.reason, `${file}.reason`),
    }
  })

  const declared = new Set([...filePaths, ...appliesTo, ...removals.map((removal) => removal.file)])
  for (const file of declared) {
    if (!filePaths.has(file)) fail(`manifest: ${file} is used by a transformation but has no fingerprint entry`)
  }
  for (const removal of removals) {
    if (!declared.has(removal.file)) continue
  }

  if (!Array.isArray(raw.protected)) fail("manifest: protected must be an array")
  const protectedFiles: ProtectedFile[] = raw.protected.map((entry: any) => {
    if (typeof entry !== "object" || entry === null) fail("manifest: protected entries must be objects")
    const file = assertString(entry.file, "protected[].file")
    assertRelativePath(file, "protected[].file")
    if (filePaths.has(file)) fail(`manifest: ${file} cannot be both patched and protected`)
    return {
      file,
      sha256: assertDigest(entry.sha256, `${file}.sha256`),
      reason: assertString(entry.reason, `${file}.reason`),
    }
  })

  return {
    schema: 2,
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
    injection: { line, position: "line-2", appliesTo, note: String(injection.note ?? "") },
    removals,
    files,
    protected: protectedFiles,
    preserved: Array.isArray(raw.preserved) ? raw.preserved : [],
    telemetry: raw.telemetry ?? { targets: [], preserve: [] },
  }
}

export function manifestPath(version: string) {
  return path.join(repoRoot(), "manifests", `${version}.json`)
}

export function loadManifest(version: string): Manifest {
  if (!SEMVER.test(version)) fail(`invalid upstream version: ${version}`)
  const file = manifestPath(version)
  if (!fs.existsSync(file)) fail(`No manifest for upstream ${version}: ${file}`)
  return validateManifest(JSON.parse(fs.readFileSync(file, "utf8")))
}

/**
 * Verify the checkout is the pinned upstream revision.
 *
 * Git metadata is authoritative when present. A source archive without it is
 * only accepted when every declared pristine fingerprint matches, which pins
 * the exact reviewed bytes.
 */
export function verifyUpstreamIdentity(root: string, manifest: Manifest) {
  const pkgFile = resolveTarget(root, "packages/cli/package.json")
  if (!fs.existsSync(pkgFile)) fail(`not an OpenCode checkout (missing packages/cli/package.json): ${root}`)
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { name?: string; version?: string }
  if (pkg.name !== manifest.upstream.npmPackage)
    fail(`checkout package ${pkg.name ?? "<missing>"} does not match manifest ${manifest.upstream.npmPackage}`)
  if (pkg.version !== manifest.upstream.version)
    fail(
      `checkout version ${pkg.version ?? "<missing>"} does not match manifest ${manifest.upstream.version}; ` +
        `refusing to patch an unsupported source`,
    )

  const head = gitHead(root)
  if (head === undefined) return true
  if (head === manifest.upstream.commit) return true
  // A derivative checkout records its own commits on top of the pin. Accept it
  // only when every declared target is already the reviewed final content,
  // which cannot be true of an unrelated or partially patched tree.
  const final = manifest.files.every((entry) => {
    try {
      return sha256(read(root, entry.file)) === entry.final
    } catch {
      return false
    }
  })
  if (final) return true
  fail(
    `checkout HEAD ${head} is neither the pinned upstream commit ${manifest.upstream.commit} ` +
      `nor a fully patched derivative tree; refusing to patch an unsupported source`,
  )
}

function gitHead(root: string) {
  if (!fs.existsSync(path.join(root, ".git"))) return undefined
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim()
    if (!head.startsWith("ref: ")) return head
    const ref = head.slice("ref: ".length)
    const loose = path.join(root, ".git", ref)
    if (fs.existsSync(loose)) return fs.readFileSync(loose, "utf8").trim()
    const packed = path.join(root, ".git", "packed-refs")
    if (!fs.existsSync(packed)) return undefined
    for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ")
      if (name === ref && sha !== undefined) return sha
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Plan the whole transformation set.
 *
 * The tree must be uniformly pristine or uniformly final. Every computed output
 * is checked against its declared fingerprint before anything is returned, so a
 * caller can commit afterwards knowing the entire set validated.
 */
export function plan(
  root: string,
  manifest: Manifest,
  transforms: ReadonlyMap<string, (content: string) => string>,
): Planned[] {
  const planned: Planned[] = []
  const states: Array<"pristine" | "final"> = []

  for (const entry of manifest.files) {
    if (entry.pristine === null) {
      // An added file must be absent upstream and is written from the reviewed bytes.
      const target = resolveTarget(root, entry.file)
      if (fs.existsSync(target)) {
        const digest = sha256(read(root, entry.file))
        if (digest === entry.final) {
          states.push("final")
          planned.push({ file: entry.file, next: read(root, entry.file), change: undefined })
          continue
        }
        fail(`${entry.file}: derivative-added file exists with unexpected content`)
      }
      const transform = transforms.get(entry.file)
      if (!transform) fail(`${entry.file}: no transformation is registered for this manifest entry`)
      const added = transform("")
      if (sha256(added) !== entry.final)
        fail(`${entry.file}: reviewed output does not match the manifest final digest`)
      const parent = path.dirname(target)
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true })
      states.push("pristine")
      planned.push({ file: entry.file, next: added, change: { file: entry.file, reason: entry.reason } })
      continue
    }
    const before = read(root, entry.file)
    const digest = sha256(before)
    if (digest === entry.final) {
      states.push("final")
      planned.push({ file: entry.file, next: before, change: undefined })
      continue
    }
    if (digest !== entry.pristine)
      fail(
        `${entry.file}: neither pristine nor final for upstream ${manifest.upstream.version}. ` +
          `Refusing to guess (partially patched, drifted, or unsupported source).`,
      )
    const transform = transforms.get(entry.file)
    if (!transform) fail(`${entry.file}: no transformation is registered for this manifest entry`)
    const after = transform(before)
    const output = sha256(after)
    if (output !== entry.final)
      fail(
        `${entry.file}: computed output ${output.slice(0, 12)} does not match the reviewed final ` +
          `${entry.final.slice(0, 12)}. The transformation and manifest disagree.`,
      )
    states.push("pristine")
    planned.push({ file: entry.file, next: after, change: { file: entry.file, reason: entry.reason } })
  }

  const pristine = states.filter((state) => state === "pristine").length
  if (pristine !== 0 && pristine !== states.length)
    fail(
      `mixed patch state: ${pristine} of ${states.length} files are pristine and the rest are final. ` +
        `Restore the source tree, then apply the manifest once.`,
    )

  for (const entry of manifest.protected) {
    const digest = sha256(read(root, entry.file))
    if (digest !== entry.sha256)
      fail(`${entry.file}: protected file does not match the reviewed upstream content (${entry.reason})`)
  }

  return planned
}

/** Commit a validated plan. Callers must not write before `plan` succeeds. */
export function commit(root: string, planned: ReadonlyArray<Planned>) {
  const changes: Change[] = []
  for (const item of planned) {
    if (!item.change) continue
    write(root, item.file, item.next)
    changes.push(item.change)
  }
  return changes
}

/** Verify every declared file is final and every protected file is untouched. */
export function verify(root: string, manifest: Manifest) {
  const errors: string[] = []
  for (const entry of manifest.files) {
    let content: string
    try {
      content = read(root, entry.file)
    } catch (error) {
      errors.push(`${entry.file}: ${(error as Error).message}`)
      continue
    }
    const digest = sha256(content)
    if (digest !== entry.final) errors.push(`${entry.file}: does not match the reviewed final content`)
  }
  for (const entry of manifest.protected) {
    try {
      const digest = sha256(read(root, entry.file))
      if (digest !== entry.sha256)
        errors.push(`${entry.file}: protected file changed (${entry.reason})`)
    } catch (error) {
      errors.push(`${entry.file}: ${(error as Error).message}`)
    }
  }
  return errors
}

export function applyRoot(root: string, manifest: Manifest, transforms: ReadonlyMap<string, (content: string) => string>) {
  const planned = plan(root, manifest, transforms)
  return commit(root, planned)
}

export function cliRoot(args: string[]) {
  const index = args.indexOf("--root")
  return index === -1 ? process.cwd() : path.resolve(args[index + 1] ?? ".")
}
