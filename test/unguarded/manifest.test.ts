import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { loadManifest } from "../../script/unguarded/apply"

const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")
const manifest = loadManifest("2.1.2")

describe("manifest records", () => {
  test("declares an upstream pin, a derivative revision, and a schema", () => {
    expect(manifest.schema).toBe(2)
    expect(manifest.upstream.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.upstream.npmPackage).toBe("@opencode/cli")
    const raw = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests/2.1.2.json"), "utf8"))
    expect(Number.isInteger(raw.derivativeRevision)).toBe(true)
    expect(raw.derivativeRevision).toBeGreaterThanOrEqual(3)
  })

  test("each transformation documents why it exists", () => {
    for (const removal of manifest.removals) expect(removal.reason.length).toBeGreaterThan(10)
    for (const file of manifest.files) expect(file.reason.length).toBeGreaterThan(10)
    for (const file of manifest.protected) expect(file.reason.length).toBeGreaterThan(5)
  })

  test("protects every runtime contract named in the preserved list", () => {
    const protectedFiles = manifest.protected.map((entry) => entry.file)
    expect(protectedFiles).toContain("packages/core/src/permission.ts")
    expect(protectedFiles).toContain("packages/core/src/plugin/agent.ts")
    expect(protectedFiles).toContain("packages/core/src/plugin/plan.ts")
    expect(protectedFiles).toContain("packages/core/src/plugin/system-prompt/anthropic.txt")
  })

  test("does not patch any protected file", () => {
    const patched = new Set(manifest.files.map((entry) => entry.file))
    for (const entry of manifest.protected) expect(patched.has(entry.file)).toBe(false)
  })

  test("every prompt route is covered exactly once", () => {
    const routes = [
      "packages/core/src/session/runner/prompt/system.txt",
      "packages/core/src/plugin/system-prompt/gpt.txt",
      "packages/core/src/plugin/system-prompt/gpt-astra.txt",
      "packages/core/src/plugin/system-prompt/kimi.txt",
      "packages/core/src/plugin/system-prompt/meta.txt",
      "packages/core/src/plugin/system-prompt/trinity.txt",
    ]
    expect([...manifest.injection.appliesTo].sort()).toEqual([...routes].sort())
  })

  test("the reviewed outputs carry the directive at line 2 exactly once", () => {
    for (const file of manifest.injection.appliesTo) {
      const content = fs.readFileSync(path.join(repoRoot, "patches/2.1.2", file), "utf8")
      expect(content.split("\n")[1]).toBe(manifest.injection.line)
      expect(content.split(manifest.injection.line).length - 1).toBe(1)
    }
  })

  test("the Anthropic appendix stays upstream and unmarked", () => {
    const appendix = fs.readFileSync(
      path.join(repoRoot, "packages/core/src/plugin/system-prompt/anthropic.txt"),
      "utf8",
    )
    expect(appendix.includes(manifest.injection.line)).toBe(false)
    const upstream = process.env.UNGUARDED_UPSTREAM
    if (!upstream) return
    expect(appendix).toBe(
      fs.readFileSync(path.join(upstream, "packages/core/src/plugin/system-prompt/anthropic.txt"), "utf8"),
    )
  })
})
