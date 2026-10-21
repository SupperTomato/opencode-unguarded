import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  verifyDerivativeUninstall,
  verifyLifecycle,
  verifyServiceOwnership,
  verifyUpdaterBoundary,
} from "../../script/unguarded/lifecycle"
import { loadManifest, read } from "../../script/unguarded/apply"

const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")
const manifest = loadManifest("2.1.2")

const files = new Set([...manifest.files.map((entry) => entry.file), ...manifest.protected.map((entry) => entry.file)])

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-lifecycle-"))
  for (const file of files) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, file), target)
  }
  return root
}

function rewrite(root: string, file: string, transform: (content: string) => string) {
  const target = path.join(root, file)
  fs.writeFileSync(target, transform(fs.readFileSync(target, "utf8")))
}

describe("lifecycle verification", () => {
  test("the checked-in source satisfies every invariant", () => {
    expect(verifyLifecycle(repoRoot, manifest)).toEqual([])
  })

  test("every updater entry point is gated", () => {
    const root = fixture()
    expect(verifyUpdaterBoundary(root)).toEqual([])
    rewrite(root, "packages/cli/src/services/updater.ts", (content) =>
      content.replace(
        /const upgrade = Effect\.fnUntraced\(function\* \(method: Method, input: string\) \{\s*if \(UNGUARDED\)[^\n]*\n/,
        "const upgrade = Effect.fnUntraced(function* (method: Method, input: string) {\n",
      ),
    )
    expect(verifyUpdaterBoundary(root).join("\n")).toMatch(/upgrade\(\) does not enforce/)
  })

  test("a guard that exists only as a comment is rejected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/services/updater.ts", (content) =>
      content.replace("if (UNGUARDED) return yield* Effect.fail(derivativeUpdateError())", "// if (UNGUARDED) disabled"),
    )
    expect(verifyUpdaterBoundary(root)).not.toEqual([])
  })

  test("removing the command-level refusal is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/commands/handlers/upgrade.ts", (content) =>
      content.replace("if (UNGUARDED) return yield* Effect.fail(new Error(Updater.DERIVATIVE_UPDATE_MESSAGE))", ""),
    )
    expect(verifyUpdaterBoundary(root).join("\n")).toMatch(/does not refuse before resolving a method/)
  })

  test("removing the registration ownership marker is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/services/service-registration.ts", (content) =>
      content.replace("derivative: options.derivative,", ""),
    )
    expect(verifyServiceOwnership(root).join("\n")).toMatch(/not marked with the derivative build identity/)
  })

  test("restoring stock service.json migration is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/services/service-config.ts", (content) =>
      content.replace('!UNGUARDED && name !== "service.json"', 'name !== "service.json"'),
    )
    expect(verifyServiceOwnership(root).join("\n")).toMatch(/stock service\.json file is still a migration candidate/)
  })

  test("restoring the stock database selection is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/database-path.ts", (content) =>
      content.replace("if (UNGUARDED) return derivativeDatabase(data)", ""),
    )
    expect(verifyServiceOwnership(root).join("\n")).toMatch(/derivative database is not selected/)
  })

  test("dropping the :memory: override is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/database-path.ts", (content) =>
      content.replace('if (override === ":memory:") return override', ""),
    )
    expect(verifyServiceOwnership(root).join("\n")).toMatch(/:memory: override is not honored/)
  })

  test("removing the derivative removal branch is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/commands/handlers/uninstall.ts", (content) =>
      content.replace("if (UNGUARDED) return yield* uninstallDerivative(input)", ""),
    )
    expect(verifyDerivativeUninstall(root).join("\n")).toMatch(/removal path is not selected/)
  })

  test("a salt-in-the-prompt removal route is detected", () => {
    const root = fixture()
    rewrite(root, "packages/cli/src/commands/handlers/uninstall.ts", (content) =>
      `${content}\n// updater.removal(method)\n`,
    )
    expect(verifyDerivativeUninstall(root).join("\n")).toMatch(/upstream cleanup/)
  })

  test("the derivative port differs from every stock port", () => {
    const service = read(repoRoot, "packages/cli/src/services/service-config.ts")
    const derivative = /if \(channel === DERIVATIVE_CHANNEL\) return (\d+)/.exec(service)
    const stock = /channel === "next"\) return (0x[0-9a-f]+)/.exec(service)
    expect(derivative).not.toBeNull()
    expect(stock).not.toBeNull()
    expect(Number(derivative![1])).not.toBe(parseInt(stock![1], 16))
  })
})
