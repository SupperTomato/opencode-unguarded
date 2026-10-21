import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  apply,
  loadManifest,
  patchDir,
  plan,
  sha256,
  transforms,
  validateManifest,
  verify,
  verifyUpstreamIdentity,
} from "../../script/unguarded/apply"

const manifest = loadManifest("2.1.2")
const upstream = process.env.UNGUARDED_UPSTREAM
const repoRoot = process.env.UNGUARDED_DERIVATIVE_ROOT ?? process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")

function requireFixture(directory: string | undefined, name: string) {
  if (!directory) throw new Error(`${name} fixture is required; set UNGUARDED_UPSTREAM to a checkout at the pinned commit`)
  if (!fs.existsSync(directory)) throw new Error(`${name} fixture does not exist: ${directory}`)
  return directory
}

/** Copy the exact pinned upstream bytes for every declared target. */
function upstreamFixture() {
  const source = requireFixture(upstream, "upstream")
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-upstream-"))
  for (const entry of manifest.files) {
    if (entry.pristine === null) continue
    const target = path.join(root, entry.file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, entry.file), target)
  }
  for (const entry of manifest.protected) {
    const target = path.join(root, entry.file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(source, entry.file), target)
  }
  const pkg = path.join(source, "packages/cli/package.json")
  fs.mkdirSync(path.join(root, "packages/cli"), { recursive: true })
  fs.copyFileSync(pkg, path.join(root, "packages/cli/package.json"))
  write(root, ".git/HEAD", `${manifest.upstream.commit}\n`)
  return root
}

function read(root: string, file: string) {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function write(root: string, file: string, content: string) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}

describe("manifest contract", () => {
  const clone = () => JSON.parse(JSON.stringify(manifest))

  test("every declared transformation has a fingerprint", () => {
    const declared = new Set(manifest.files.map((entry) => entry.file))
    for (const file of manifest.injection.appliesTo) expect(declared.has(file)).toBe(true)
    for (const removal of manifest.removals) expect(declared.has(removal.file)).toBe(true)
  })

  test("fingerprints are distinct per side", () => {
    for (const entry of manifest.files) expect(entry.pristine).not.toBe(entry.final)
  })

  test("rejects an unknown schema", () => {
    expect(() => validateManifest({ ...clone(), schema: 1 })).toThrow(/schema/)
  })

  test("rejects an absolute target path", () => {
    const value = clone()
    value.injection.appliesTo = ["/etc/passwd"]
    expect(() => validateManifest(value)).toThrow(/must be relative/)
  })

  test("rejects a traversal path", () => {
    const value = clone()
    value.injection.appliesTo = ["../outside.txt"]
    expect(() => validateManifest(value)).toThrow(/must not traverse/)
  })

  test("rejects a non-normalized path", () => {
    const value = clone()
    value.files[0].file = `./${value.files[0].file}`
    expect(() => validateManifest(value)).toThrow(/normalized/)
  })

  test("rejects a target without a fingerprint", () => {
    const value = clone()
    value.removals[0].file = "packages/core/src/other.txt"
    expect(() => validateManifest(value)).toThrow(/no fingerprint entry/)
  })

  test("rejects a file that is both patched and protected", () => {
    const value = clone()
    value.protected.push({ file: value.files[0].file, sha256: value.files[0].pristine, reason: "test" })
    expect(() => validateManifest(value)).toThrow(/both patched and protected/)
  })

  test("rejects a malformed digest", () => {
    const value = clone()
    value.files[0].pristine = "abc"
    expect(() => validateManifest(value)).toThrow(/SHA-256/)
  })

  test("rejects duplicate transformation ids", () => {
    const value = clone()
    value.removals.push({ ...value.removals[0] })
    expect(() => validateManifest(value)).toThrow(/duplicate removal id/)
  })

  test("rejects a replacement containing the original text", () => {
    const value = clone()
    const removal = value.removals.find((item: any) => item.action === "replace")
    removal.replacement = removal.match
    expect(() => validateManifest(value)).toThrow(/must differ/)
  })
})

describe("upstream identity", () => {
  test("rejects a checkout with the wrong version", () => {
    const root = upstreamFixture()
    write(root, "packages/cli/package.json", JSON.stringify({ name: "@opencode/cli", version: "9.9.9" }))
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/does not match manifest/)
  })

  test("rejects a checkout with the wrong package name", () => {
    const root = upstreamFixture()
    write(root, "packages/cli/package.json", JSON.stringify({ name: "@other/cli", version: manifest.upstream.version }))
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/does not match manifest/)
  })

  test("rejects a checkout at a different commit", () => {
    const root = upstreamFixture()
    write(root, ".git/HEAD", `${"0".repeat(40)}\n`)
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/neither the pinned upstream commit/)
  })

  test("accepts the pinned source", () => {
    expect(verifyUpstreamIdentity(upstreamFixture(), manifest)).toBe(true)
  })
})

describe("planning and application", () => {
  test("pristine source produces the reviewed final bytes", () => {
    const root = upstreamFixture()
    const changes = apply(root, manifest)
    expect(changes.length).toBe(manifest.files.length)
    expect(verify(root, manifest)).toEqual([])
    for (const entry of manifest.files) {
      expect(sha256(read(root, entry.file))).toBe(entry.final)
    }
  })

  test("a fully patched tree is a verified no-op", () => {
    const root = upstreamFixture()
    apply(root, manifest)
    expect(apply(root, manifest)).toEqual([])
  })

  test("a mixed pristine/final tree is rejected before any write", () => {
    const root = upstreamFixture()
    apply(root, manifest)
    const restored = manifest.files[0]!
    fs.copyFileSync(path.join(requireFixture(upstream, "upstream"), restored.file), path.join(root, restored.file))
    const before = read(root, manifest.files[1]!.file)
    expect(() => plan(root, manifest, transforms(manifest))).toThrow(/mixed patch state/)
    expect(read(root, manifest.files[1]!.file)).toBe(before)
  })

  test("drifted source that still contains the old anchors is rejected", () => {
    const root = upstreamFixture()
    const entry = manifest.files.find((item) => item.file.endsWith("gpt.txt"))!
    write(root, entry.file, read(root, entry.file).replace("You are an AI agent", "You are an AI assistant"))
    expect(() => apply(root, manifest)).toThrow(/neither pristine nor final/)
  })

  test("a table of expected strings is not accepted as patch evidence", () => {
    const root = upstreamFixture()
    const entry = manifest.files.find((item) => item.file.endsWith("gpt.txt"))!
    write(root, entry.file, `${manifest.injection.line}\nNever run destructive commands such as kit.\n`)
    expect(() => verify(root, manifest)).not.toEqual([])
  })

  test("a failed output check leaves every target untouched", () => {
    const root = upstreamFixture()
    const broken = {
      ...manifest,
      files: manifest.files.map((entry, index) => (index === 0 ? { ...entry, final: "0".repeat(64) } : entry)),
    }
    const existing = manifest.files.filter((entry) => entry.pristine !== null)
    const before = existing.map((entry) => read(root, entry.file))
    expect(() => apply(root, broken)).toThrow(/computed output/)
    expect(existing.map((entry) => read(root, entry.file))).toEqual(before)
  })

  test("a late rejection performs no filesystem mutation", () => {
    const root = upstreamFixture()
    const added = manifest.files.find((entry) => entry.pristine === null)!
    // Remove the added file's directory so a preflight write would be visible.
    fs.rmSync(path.join(root, path.dirname(added.file)), { recursive: true, force: true })
    const protectedFile = manifest.protected[0]!
    write(root, protectedFile.file, `${read(root, protectedFile.file)}\n// changed\n`)
    const before = manifest.files
      .filter((entry) => entry.pristine !== null)
      .map((entry) => read(root, entry.file))
    expect(() => plan(root, manifest, transforms(manifest))).toThrow(/protected file/)
    expect(fs.existsSync(path.join(root, path.dirname(added.file)))).toBe(false)
    expect(
      manifest.files.filter((entry) => entry.pristine !== null).map((entry) => read(root, entry.file)),
    ).toEqual(before)
  })

  test("a worktree checkout is verified through its real Git metadata", () => {
    const root = upstreamFixture()
    // Simulate a `.git` file pointing at unrelated metadata; identity must fail
    // closed instead of silently accepting the source.
    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true })
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /nonexistent/git-metadata\n")
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/HEAD could not be read|does not match/)
  })

  test("a synthesized HEAD without the commit object is rejected", () => {
    const root = upstreamFixture()
    const entry = manifest.files.find((item) => item.pristine !== null)!
    write(root, entry.file, "unrelated source\n")
    write(root, ".git/HEAD", `${"b".repeat(40)}\n`)
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/neither the pinned upstream commit|not a descendant/)
  })

  test("a directory without Git metadata is accepted only for pinned bytes", () => {
    const root = upstreamFixture()
    fs.rmSync(path.join(root, ".git"), { recursive: true, force: true })
    expect(verifyUpstreamIdentity(root, manifest)).toBe(true)
    const entry = manifest.files.find((item) => item.pristine !== null)!
    write(root, entry.file, "unrelated source\n")
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/does not match the pinned upstream/)
  })

  test("a protected file change is rejected", () => {
    const root = upstreamFixture()
    apply(root, manifest)
    const protectedFile = manifest.protected[0]!
    write(root, protectedFile.file, `${read(root, protectedFile.file)}\n// changed\n`)
    expect(verify(root, manifest).join("\n")).toMatch(/protected file changed/)
  })

  test("a symlinked target escaping the root is refused", () => {
    const root = upstreamFixture()
    const entry = manifest.files.find((item) => item.file.endsWith("gpt.txt"))!
    const outside = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-outside-")), "prompt.txt")
    fs.writeFileSync(outside, "outside")
    fs.rmSync(path.join(root, entry.file))
    fs.symlinkSync(outside, path.join(root, entry.file))
    expect(() => plan(root, manifest, transforms(manifest))).toThrow(/symlink/)
    expect(fs.readFileSync(outside, "utf8")).toBe("outside")
  })

  test("a symlinked parent directory escaping the root is refused", () => {
    const root = upstreamFixture()
    const outside = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-parent-"))
    fs.mkdirSync(path.join(outside, "system-prompt"), { recursive: true })
    fs.rmSync(path.join(root, "packages/core/src/plugin/system-prompt"), { recursive: true, force: true })
    fs.symlinkSync(path.join(outside, "system-prompt"), path.join(root, "packages/core/src/plugin/system-prompt"))
    expect(() => plan(root, manifest, transforms(manifest))).toThrow(/symlink/)
  })

  test("a hard-linked target is refused", () => {
    const root = upstreamFixture()
    const entry = manifest.files.find((item) => item.file.endsWith("gpt.txt"))!
    const outside = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-hardlink-")), "prompt.txt")
    fs.linkSync(path.join(root, entry.file), outside)
    expect(() => plan(root, manifest, transforms(manifest))).toThrow(/hard-linked/)
  })
})

describe("reviewed output completeness", () => {
  test("the checked-in derivative tree matches the reviewed outputs", () => {
    expect(verify(repoRoot, manifest)).toEqual([])
  })

  test("every reviewed output is present on disk", () => {
    const source = process.env.UNGUARDED_DERIVATIVE_ROOT ?? repoRoot
    for (const entry of manifest.files) {
      expect(fs.existsSync(path.join(source, "patches", manifest.upstream.version, entry.file))).toBe(true)
    }
  })
})
