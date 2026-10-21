import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { stripTelemetry, verifyTelemetryDisabled } from "../../script/unguarded/telemetry"

const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")

const files = [
  "packages/cli/package.json",
  "packages/util/src/observability/otlp.ts",
  "packages/util/src/observability.ts",
  "packages/app/src/entry.tsx",
  "packages/app/vite.config.ts",
  "packages/desktop/electron.vite.config.ts",
  "packages/desktop/src/renderer/startup/sentry.ts",
  "packages/util/test/observability-otlp.test.ts",
]

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-telemetry-"))
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

describe("telemetry verification", () => {
  test("checked-in source verifies clean", () => {
    expect(verifyTelemetryDisabled(repoRoot)).toEqual([])
  })

  test("rejects a nonexistent root", () => {
    expect(verifyTelemetryDisabled("/tmp/definitely-not-a-checkout-xyz")).toEqual([
      "/tmp/definitely-not-a-checkout-xyz: checkout does not exist",
    ])
  })

  test("rejects a directory that is not an OpenCode checkout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-empty-"))
    expect(verifyTelemetryDisabled(root)[0]).toMatch(/not an OpenCode checkout/)
  })

  test("rejects a missing required file", () => {
    const root = fixture()
    fs.rmSync(path.join(root, "packages/util/src/observability/otlp.ts"))
    expect(verifyTelemetryDisabled(root).join("\n")).toMatch(/required file is missing/)
  })

  test("detects a restored OTLP exporter beneath a retained marker", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability/otlp.ts", (content) =>
      `${content}\nconst exporter = new OTLPTraceExporter({ url: "/v1/traces" })\n`,
    )
    const errors = verifyTelemetryDisabled(root).join("\n")
    expect(errors).toMatch(/OTLPTraceExporter remains/)
    expect(errors).toMatch(/\/v1\/traces remains/)
  })

  test("detects a restored exporter layer in observability.ts", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability.ts", (content) =>
      content.replace("return local", "return Layer.merge(local, Otlp.tracingLayer(options, app))"),
    )
    expect(verifyTelemetryDisabled(root).join("\n")).toMatch(/Otlp\. remains/)
  })

  test("detects a lost local logging layer", () => {
    const root = fixture()
    rewrite(root, "packages/util/src/observability.ts", (content) =>
      content.replace("Logging.loggers(", "someOtherLogger("),
    )
    expect(verifyTelemetryDisabled(root).join("\n")).toMatch(/local logging is not preserved/)
  })

  test("detects restored browser Sentry initialization", () => {
    const root = fixture()
    rewrite(root, "packages/app/src/entry.tsx", (content) => `import { init } from "@sentry/solid"\n${content}`)
    expect(verifyTelemetryDisabled(root).join("\n")).toMatch(/Sentry import remains/)
  })

  test("detects a restored dynamic Sentry plugin import", () => {
    const root = fixture()
    rewrite(root, "packages/desktop/electron.vite.config.ts", (content) =>
      content.replace(
        "const sentry = false",
        'const sentry =\n  process.env.A && process.env.B && process.env.C\n    ? (await import("@sentry/vite-plugin")).sentryVitePlugin({})\n    : false',
      ),
    )
    const errors = verifyTelemetryDisabled(root).join("\n")
    expect(errors).toMatch(/dynamic Sentry import remains/)
    expect(errors).toMatch(/Sentry build plugin is still constructed/)
  })

  test("detects a restored static Sentry plugin import", () => {
    const root = fixture()
    rewrite(root, "packages/app/vite.config.ts", (content) =>
      content.replace(
        "const sentryVitePlugin = (..._args: unknown[]) => false",
        'import { sentryVitePlugin } from "@sentry/vite-plugin"',
      ),
    )
    expect(verifyTelemetryDisabled(root).join("\n")).toMatch(/Sentry import remains/)
  })

  test("detects a desktop shim that dropped desktopVersion", () => {
    const root = fixture()
    rewrite(root, "packages/desktop/src/renderer/startup/sentry.ts", () => "export const nothing = 1\n")
    expect(verifyTelemetryDisabled(root).join("\n")).toMatch(/desktopVersion export was dropped/)
  })
})

describe("telemetry patch determinism", () => {
  test("second application is a no-op on the checked-in tree", () => {
    const root = fixture()
    expect(stripTelemetry(root)).toEqual([])
  })

  test("one pass from pristine produces the checked-in output", () => {
    const root = fixture()
    // Restore pristine upstream text for every target by copying from the pinned worktree.
    const pristine = process.env.UNGUARDED_PRISTINE
    if (!pristine) return
    for (const file of files) {
      fs.copyFileSync(path.join(pristine, file), path.join(root, file))
    }
    stripTelemetry(root)
    for (const file of files) {
      expect(fs.readFileSync(path.join(root, file), "utf8")).toBe(fs.readFileSync(path.join(repoRoot, file), "utf8"))
    }
    expect(stripTelemetry(root)).toEqual([])
  })
})
