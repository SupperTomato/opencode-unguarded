import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { apply, loadManifest, plan, verify } from "../../script/unguarded/apply"

const manifest = loadManifest("2.1.2")

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-test-"))
  for (const file of new Set([
    ...manifest.injection.appliesTo,
    ...manifest.removals.map((removal) => removal.file),
  ])) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, fs.readFileSync(path.join(import.meta.dir, "..", "..", file), "utf8"))
  }
  return root
}

function pristineFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-pristine-"))
  for (const file of new Set([
    ...manifest.injection.appliesTo,
    ...manifest.removals.map((removal) => removal.file),
  ])) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    let content = fs.readFileSync(path.join(import.meta.dir, "..", "..", file), "utf8")
    content = content.replace(`${manifest.injection.line}\n`, "")
    for (const removal of manifest.removals.filter((item) => item.file === file)) {
      if (removal.action === "replace") {
        content = content.split(removal.replacement ?? "").join(removal.match)
        continue
      }
      if (removal.action === "replace-with-empty") {
        const lines = content.split("\n")
        const index = lines.findIndex((line) => line.startsWith("- Remember active user corrections"))
        if (index !== -1) lines[index] = lines[index] + removal.match
        content = lines.join("\n")
        continue
      }
      const lines = content.split("\n")
      if (lines.includes(removal.match)) continue
      lines.splice(1, 0, removal.match)
      content = lines.join("\n")
    }
    fs.writeFileSync(target, content)
  }
  return root
}

describe("guardrail manifest", () => {
  test("is pinned to a specific upstream commit", () => {
    expect(manifest.upstream.version).toBe("2.1.2")
    expect(manifest.upstream.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  test("every removal targets an existing file and is uniquely anchored", () => {
    for (const removal of manifest.removals) {
      const file = path.join(import.meta.dir, "..", "..", removal.file)
      expect(fs.existsSync(file)).toBe(true)
      expect(removal.reason.length).toBeGreaterThan(10)
    }
  })

  test("does not inject into plan, explore, or transition prompts", () => {
    for (const file of manifest.injection.appliesTo) {
      expect(file).not.toContain("plan")
      expect(file).not.toContain("system.txt")
    }
  })

  test("applies cleanly to the checked-in source", () => {
    expect(verify(path.join(import.meta.dir, "..", ".."), manifest)).toEqual([])
  })

  test("second application is a no-op", () => {
    const root = fixture()
    expect(apply(root, manifest)).toEqual([])
  })

  test("rejects a source with a missing anchor instead of silently skipping", () => {
    const root = pristineFixture()
    const target = path.join(root, manifest.removals[0].file)
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(manifest.removals[0].match, ""))
    expect(() => plan(root, manifest)).toThrow()
  })

  test("rejects a partially patched file", () => {
    const root = fixture()
    const removal = manifest.removals.find((item) => manifest.injection.appliesTo.includes(item.file))!
    const target = path.join(root, removal.file)
    fs.writeFileSync(target, `${fs.readFileSync(target, "utf8")}\n${removal.match}\n`)
    expect(() => plan(root, manifest)).toThrow(/partially patched/)
  })

  test("places the directive on line two", () => {
    for (const file of manifest.injection.appliesTo) {
      const lines = fs.readFileSync(path.join(import.meta.dir, "..", "..", file), "utf8").split("\n")
      expect(lines[1]).toBe(manifest.injection.line)
    }
  })

  test("preserves runtime permission defaults", () => {
    const plan = fs.readFileSync(path.join(import.meta.dir, "..", "..", "packages/core/src/plugin/plan.ts"), "utf8")
    expect(plan).toContain('item.permissions.push({ action: "edit", resource: "*", effect: "deny" })')
    const agent = fs.readFileSync(path.join(import.meta.dir, "..", "..", "packages/core/src/plugin/agent.ts"), "utf8")
    expect(agent).toContain('{ action: "read", resource: "*.env", effect: "ask" }')
    expect(agent).toContain('{ action: "*", resource: "*", effect: "deny" }')
  })
})
