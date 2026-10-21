import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repoRoot = process.env.UNGUARDED_DERIVATIVE_ROOT ?? path.join(import.meta.dir, "..", "..")
const launcherSource = path.join(repoRoot, "packaging/linux-x64/launcher")
const launcher = fs.readFileSync(launcherSource, "utf8")

/** Run the launcher with a stub binary that records its environment. */
function run(
  args: string[],
  env: Record<string, string | undefined>,
  setup?: (root: string, home: string) => void,
  envFor?: (root: string, home: string) => Record<string, string | undefined>,
) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-launcher-"))
  const home = path.join(root, "home")
  fs.mkdirSync(path.join(root, "bin"), { recursive: true })
  fs.mkdirSync(path.join(root, "libexec"), { recursive: true })
  fs.mkdirSync(home, { recursive: true })
  const record = path.join(root, "record.json")
  const binary = path.join(root, "libexec", "opencode")
  fs.writeFileSync(
    binary,
    `#!${process.execPath}\nimport fs from "node:fs"\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("XDG_") || key.startsWith("OPENCODE_") || key === "TMPDIR")) }))\n`,
    { mode: 0o755 },
  )
  fs.copyFileSync(launcherSource, path.join(root, "bin", "opencode-unguarded"))
  fs.chmodSync(path.join(root, "bin", "opencode-unguarded"), 0o755)
  setup?.(root, home)
  const base: Record<string, string> = {
    HOME: home,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
  }
  const resolved = { ...env, ...(envFor?.(root, home) ?? {}) }
  const child = Bun.spawnSync([path.join(root, "bin", "opencode-unguarded"), ...args], {
    env: {
      ...base,
      ...Object.fromEntries(Object.entries(resolved).filter(([, value]) => value !== undefined)),
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  const recorded = fs.existsSync(record)
    ? (JSON.parse(fs.readFileSync(record, "utf8")) as { args: string[]; env: Record<string, string> })
    : undefined
  return { exitCode: child.exitCode, stdout, stderr, recorded, root, home }
}

describe("launcher profile containment", () => {
  test("exports a canonical profile and passes arguments through", () => {
    const result = run(["debug", "paths"], {})
    expect(result.exitCode).toBe(0)
    expect(result.recorded?.args).toEqual(["debug", "paths"])
    expect(result.recorded?.env.XDG_DATA_HOME).toBe(path.join(result.root, "home", ".local", "share", "opencode-unguarded/profile/data"))
    expect(result.recorded?.env.OPENCODE_UNGUARDED_PROFILE).toBe(
      path.join(result.root, "home", ".local", "share", "opencode-unguarded/profile"),
    )
    expect(result.recorded?.env.OPENCODE_UNGUARDED_ROOT).toBe(result.root)
  })

  test("refuses inherited configuration overrides without creating a profile", () => {
    for (const name of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_TEST_HOME"]) {
      const result = run([], { [name]: "/tmp/elsewhere" })
      expect({ name, exitCode: result.exitCode }).toEqual({ name, exitCode: 1 })
      expect(result.stderr).toContain(name)
      expect(fs.existsSync(path.join(result.home, ".local", "share", "opencode-unguarded"))).toBe(false)
    }
  })

  test("refuses a profile inside stock application storage", () => {
    for (const stock of ["data", "config", "cache", "state"]) {
      const blocked = run(
        [],
        {},
        (_root, home) => fs.mkdirSync(path.join(home, ".local/share/opencode"), { recursive: true }),
        (_root, home) => ({ OPENCODE_UNGUARDED_PROFILE: path.join(home, ".local/share/opencode", stock) }),
      )
      expect({ stock, exitCode: blocked.exitCode }).toEqual({ stock, exitCode: 1 })
    }
    const relative = run([], { OPENCODE_UNGUARDED_PROFILE: "relative/profile" })
    expect(relative.exitCode).toBe(1)
    expect(relative.stderr).toContain("absolute path")
  })

  test("refuses an absolute or traversing database override", () => {
    expect(run([], { OPENCODE_DB: "/etc/passwd" }).exitCode).toBe(1)
    expect(run([], { OPENCODE_DB: "../escape.db" }).exitCode).toBe(1)
    expect(run([], { OPENCODE_DB: "nested/escape.db" }).exitCode).toBe(1)
  })

  test("permits a plain database filename and :memory:", () => {
    const plain = run([], { OPENCODE_DB: "custom.db" })
    expect(plain.exitCode).toBe(0)
    expect(plain.recorded?.env.OPENCODE_DB).toBe("custom.db")
    const memory = run([], { OPENCODE_DB: ":memory:" })
    expect(memory.exitCode).toBe(0)
    expect(memory.recorded?.env.OPENCODE_DB).toBe(":memory:")
  })

  test("refuses a symlinked database inside the profile", () => {
    const result = run([], { OPENCODE_DB: "linked.db" }, (_root, home) => {
      const data = path.join(home, ".local", "share", "opencode-unguarded/profile/data/opencode")
      fs.mkdirSync(data, { recursive: true })
      fs.writeFileSync(path.join(_root, "outside.db"), "")
      fs.symlinkSync(path.join(_root, "outside.db"), path.join(data, "linked.db"))
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("symlinked database")
  })

  test("refuses a symlinked nested application directory", () => {
    for (const name of ["data", "config", "cache", "state", "tmp"]) {
      const result = run([], {}, (root, home) => {
        const parent = path.join(home, ".local", "share", "opencode-unguarded/profile", name)
        fs.mkdirSync(parent, { recursive: true })
        fs.mkdirSync(path.join(root, "outside"), { recursive: true })
        fs.symlinkSync(path.join(root, "outside"), path.join(parent, "opencode"))
      })
      expect({ name, exitCode: result.exitCode }).toEqual({ name, exitCode: 1 })
      expect(result.stderr).toContain("symlinked application directory")
    }
  })

  test("refuses a symlinked default database", () => {
    const result = run([], {}, (root, home) => {
      const data = path.join(home, ".local", "share", "opencode-unguarded/profile/data/opencode")
      fs.mkdirSync(data, { recursive: true })
      fs.writeFileSync(path.join(root, "outside.db"), "")
      fs.symlinkSync(path.join(root, "outside.db"), path.join(data, "opencode-unguarded.db"))
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("symlinked database")
  })

  test("refuses symlinked profile storage", () => {
    const result = run([], {}, (root, home) => {
      const profile = path.join(home, ".local", "share", "opencode-unguarded/profile")
      fs.mkdirSync(profile, { recursive: true })
      fs.symlinkSync(root, path.join(profile, "state"))
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("symlinked profile storage")
  })

  test("refuses inherited server attachment", () => {
    const result = run([], { OPENCODE_SERVER_URL: "http://127.0.0.1:49374" })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("server attachment")
  })

  test("keeps the launcher free of stock lifecycle cleanup", () => {
    expect(launcher).not.toContain("opencode.ai")
    expect(launcher).not.toContain("service.json")
    expect(launcher).toContain("OPENCODE_UNGUARDED_ROOT")
  })
})
