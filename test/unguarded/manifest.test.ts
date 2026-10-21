import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  apply,
  isPatched,
  isPristine,
  loadManifest,
  plan,
  validateManifest,
  verify,
  verifyUpstreamIdentity,
} from "../../script/unguarded/apply"

const manifest = loadManifest("2.1.2")
const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")

const touched = new Set<string>([
  ...manifest.injection.appliesTo,
  ...manifest.removals.map((removal) => removal.file),
])

function copyFiles(root: string) {
  for (const file of touched) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, file), target)
  }
  const pkg = path.join(root, "packages/cli/package.json")
  fs.mkdirSync(path.dirname(pkg), { recursive: true })
  fs.writeFileSync(pkg, JSON.stringify({ name: "@opencode/cli", version: manifest.upstream.version }))
}

/** Build a patched fixture by copying the checked-in (already patched) files. */
function patchedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-patched-"))
  copyFiles(root)
  return root
}

/** Reconstruct pristine upstream text from the checked-in patched text. */
function pristineFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-pristine-"))
  copyFiles(root)
  for (const file of touched) {
    const target = path.join(root, file)
    let content = fs.readFileSync(target, "utf8")
    if (manifest.injection.appliesTo.includes(file)) {
      const lines = content.split("\n")
      if (lines[1] === manifest.injection.line) lines.splice(1, 1)
      content = lines.join("\n")
    }
    for (const removal of manifest.removals.filter((item) => item.file === file)) {
      if (removal.action === "replace") {
        content = content.replace(removal.replacement!, removal.match)
        continue
      }
      if (removal.action === "replace-with-empty") {
        const anchor = "has explicitly lifted them."
        if (!content.includes(anchor)) throw new Error(`fixture: missing anchor for ${removal.id}`)
        content = content.replace(anchor, `${anchor}${removal.match}`)
        continue
      }
      const lines = content.split("\n")
      if (!lines.includes(removal.match)) lines.splice(1, 0, removal.match)
      content = lines.join("\n")
    }
    fs.writeFileSync(target, content)
  }
  return root
}

function rewrite(root: string, file: string, transform: (content: string) => string) {
  const target = path.join(root, file)
  fs.writeFileSync(target, transform(fs.readFileSync(target, "utf8")))
}

describe("manifest validation", () => {
  const clone = () => JSON.parse(JSON.stringify(manifest))

  test("accepts the checked-in manifest", () => {
    expect(() => validateManifest(clone())).not.toThrow()
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

  test("rejects duplicate transformation ids", () => {
    const value = clone()
    value.removals.push({ ...value.removals[0] })
    expect(() => validateManifest(value)).toThrow(/duplicate removal id/)
  })

  test("rejects a malformed commit", () => {
    const value = clone()
    value.upstream.commit = "not-a-sha"
    expect(() => validateManifest(value)).toThrow(/40-character SHA/)
  })

  test("rejects a replacement that contains the original text", () => {
    const value = clone()
    const removal = value.removals.find((item: any) => item.action === "replace")
    removal.replacement = removal.match
    expect(() => validateManifest(value)).toThrow(/must differ/)
  })

  test("rejects an empty match", () => {
    const value = clone()
    value.removals[0].match = ""
    expect(() => validateManifest(value)).toThrow(/non-empty string/)
  })

  test("rejects an unsupported action", () => {
    const value = clone()
    value.removals[0].action = "rewrite-everything"
    expect(() => validateManifest(value)).toThrow(/not supported/)
  })
})

describe("upstream identity", () => {
  test("rejects a checkout with the wrong version", () => {
    const root = pristineFixture()
    fs.writeFileSync(
      path.join(root, "packages/cli/package.json"),
      JSON.stringify({ name: "@opencode/cli", version: "9.9.9" }),
    )
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/does not match manifest/)
  })

  test("rejects a directory that is not an OpenCode checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-empty-"))
    expect(() => verifyUpstreamIdentity(root, manifest)).toThrow(/not an OpenCode checkout/)
  })
})

describe("patch state contract", () => {
  test("checked-in source satisfies the expected output", () => {
    expect(verify(repoRoot, manifest)).toEqual([])
  })

  test("second application is a no-op", () => {
    const root = patchedFixture()
    expect(apply(root, manifest)).toEqual([])
  })

  test("pristine source patches to the expected output", () => {
    const root = pristineFixture()
    expect(isPristine(fs.readFileSync(path.join(root, touched.values().next().value!), "utf8"), manifest, touched.values().next().value!)).toBe(true)
    apply(root, manifest)
    expect(verify(root, manifest)).toEqual([])
    for (const file of touched) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(
        fs.readFileSync(path.join(repoRoot, file), "utf8"),
      )
    }
  })

  test("rejects a restored original sentence for a replace action", () => {
    const root = patchedFixture()
    const removal = manifest.removals.find((item) => item.action === "replace")!
    rewrite(root, removal.file, (content) => content.replace(removal.replacement!, removal.match))
    expect(verify(root, manifest).length).toBeGreaterThan(0)
    expect(() => plan(root, manifest)).toThrow(/neither pristine nor fully patched/)
  })

  test("rejects a deleted replacement sentence", () => {
    const root = patchedFixture()
    const removal = manifest.removals.find((item) => item.action === "replace")!
    rewrite(root, removal.file, (content) => content.replace(removal.replacement!, ""))
    expect(verify(root, manifest).length).toBeGreaterThan(0)
  })

  test("rejects a duplicated replacement sentence", () => {
    const root = patchedFixture()
    const removal = manifest.removals.find((item) => item.action === "replace")!
    rewrite(root, removal.file, (content) => `${content}\n${removal.replacement}\n`)
    expect(verify(root, manifest).length).toBeGreaterThan(0)
  })

  test("rejects a duplicated directive", () => {
    const root = patchedFixture()
    const file = manifest.injection.appliesTo[0]
    rewrite(root, file, (content) => `${content}\n${manifest.injection.line}\n`)
    expect(verify(root, manifest).length).toBeGreaterThan(0)
  })

  test("rejects a misplaced directive", () => {
    const root = patchedFixture()
    const file = manifest.injection.appliesTo[0]
    rewrite(root, file, (content) => {
      const lines = content.split("\n").filter((line) => line !== manifest.injection.line)
      lines.push(manifest.injection.line)
      return lines.join("\n")
    })
    expect(verify(root, manifest).length).toBeGreaterThan(0)
  })

  test("rejects a changed anchor count", () => {
    const root = patchedFixture()
    const removal = manifest.removals.find((item) => item.action === "delete-line")!
    rewrite(root, removal.file, (content) => `${content}\n${removal.match}\n`)
    expect(() => plan(root, manifest)).toThrow(/neither pristine nor fully patched/)
  })

  test("rejects a partially patched tree", () => {
    const root = pristineFixture()
    const [first, second] = [...touched]
    rewrite(root, first, (content) => `${content}\n${manifest.injection.line}\n`)
    expect(() => plan(root, manifest)).toThrow()
    expect(isPatched(fs.readFileSync(path.join(root, second), "utf8"), manifest, second)).toBe(false)
  })

  test("preflight failure writes nothing", () => {
    const root = pristineFixture()
    const removal = manifest.removals[0]
    // Corrupt a later target so preflight fails after earlier files planned cleanly.
    const victim = [...touched].at(-1)!
    const before = fs.readFileSync(path.join(root, victim), "utf8")
    rewrite(root, victim, () => "corrupted\n")
    expect(() => apply(root, manifest)).toThrow()
    expect(fs.readFileSync(path.join(root, victim), "utf8")).toBe("corrupted\n")
    for (const file of touched) {
      if (file === victim) continue
      expect(isPristine(fs.readFileSync(path.join(root, file), "utf8"), manifest, file)).toBe(true)
    }
    expect(removal.id.length).toBeGreaterThan(0)
    expect(before.length).toBeGreaterThan(0)
  })
})
