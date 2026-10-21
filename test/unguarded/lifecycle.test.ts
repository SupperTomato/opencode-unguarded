import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { patchLifecycle, verifyLifecycle } from "../../script/unguarded/lifecycle"

const repoRoot = path.join(import.meta.dir, "..", "..")

const files = [
  "packages/cli/package.json",
  "packages/cli/src/commands/handlers/upgrade.ts",
  "packages/cli/src/services/service-config.ts",
  "packages/cli/src/database-path.ts",
]

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-lifecycle-"))
  for (const file of files) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, file), target)
  }
  return root
}

describe("derivative lifecycle", () => {
  test("checked-in source verifies clean", () => {
    expect(verifyLifecycle(repoRoot)).toEqual([])
  })

  test("second application is a no-op", () => {
    expect(patchLifecycle(fixture())).toEqual([])
  })

  test("verifier detects a removed upgrade guard", () => {
    const root = fixture()
    const target = path.join(root, "packages/cli/src/commands/handlers/upgrade.ts")
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("does not self-update through the upstream installer", ""))
    expect(verifyLifecycle(root).join("\n")).toMatch(/derivative upgrade message missing/)
  })

  test("verifier detects a removed derivative channel", () => {
    const root = fixture()
    const target = path.join(root, "packages/cli/src/services/service-config.ts")
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('export const DERIVATIVE_CHANNEL = "unguarded"', ""))
    expect(verifyLifecycle(root).join("\n")).toMatch(/derivative channel missing/)
  })

  test("verifier detects a removed derivative port", () => {
    const root = fixture()
    const target = path.join(root, "packages/cli/src/services/service-config.ts")
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("if (channel === DERIVATIVE_CHANNEL) return 47499", ""))
    expect(verifyLifecycle(root).join("\n")).toMatch(/derivative port 47499 not assigned/)
  })

  test("verifier detects a restored stock database name", () => {
    const root = fixture()
    const target = path.join(root, "packages/cli/src/database-path.ts")
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("opencode-unguarded.db", "opencode.db"))
    expect(verifyLifecycle(root).join("\n")).toMatch(/derivative database name missing/)
  })

  test("derivative port differs from the stock latest port", () => {
    const service = fs.readFileSync(path.join(repoRoot, "packages/cli/src/services/service-config.ts"), "utf8")
    const derivative = /if \(channel === DERIVATIVE_CHANNEL\) return (\d+)/.exec(service)
    const stock = /channel === "next"\) return (0x[0-9a-f]+)/.exec(service)
    expect(derivative).not.toBeNull()
    expect(stock).not.toBeNull()
    expect(Number(derivative![1])).not.toBe(parseInt(stock![1], 16))
  })
})
