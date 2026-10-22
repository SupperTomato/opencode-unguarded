import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Storage containment for the direct executable.
 *
 * These run the real, compiled derivative module with the same define the
 * release build uses. Each case creates its own profile and HOME so the
 * assertion is about the effective policy, not about fixture text.
 */
const modulePath = path.join(import.meta.dir, "..", "src", "global-roots.ts")

function evaluate(script: string, env: Record<string, string>) {
  const child = Bun.spawnSync(
    [process.execPath, "--define", "OPENCODE_UNGUARDED=true", "-e", script],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

function workspace() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-roots-"))
  const home = path.join(root, "home")
  fs.mkdirSync(home, { recursive: true })
  return { root, home, profile: path.join(root, "profile") }
}

const RESOLVE = `
const { roots } = await import(${JSON.stringify(modulePath)})
try {
  console.log("OK " + JSON.stringify(roots("opencode")))
} catch (error) {
  console.log("REFUSED " + error.message)
}
`

describe("direct executable storage policy", () => {
  test("an explicit profile inside the candidate tree is accepted", () => {
    const space = workspace()
    const result = evaluate(RESOLVE, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile })
    expect(result.stdout).toStartWith("OK ")
    expect(JSON.parse(result.stdout.slice(3)).data).toBe(path.join(space.profile, "data", "opencode"))
  })

  test("the launcher's exported XDG roots are not mistaken for stock storage", () => {
    const space = workspace()
    const result = evaluate(RESOLVE, {
      HOME: space.home,
      OPENCODE_UNGUARDED_PROFILE: space.profile,
      XDG_DATA_HOME: path.join(space.profile, "data"),
      XDG_CONFIG_HOME: path.join(space.profile, "config"),
      XDG_CACHE_HOME: path.join(space.profile, "cache"),
      XDG_STATE_HOME: path.join(space.profile, "state"),
      TMPDIR: path.join(space.profile, "tmp"),
    })
    expect(result.stdout).toStartWith("OK ")
  })

  test("a profile inside stock storage is refused", () => {
    const space = workspace()
    const result = evaluate(RESOLVE, {
      HOME: space.home,
      OPENCODE_UNGUARDED_PROFILE: path.join(space.home, ".local", "share", "opencode", "profile"),
    })
    expect(result.stdout).toContain("REFUSED")
    expect(result.stdout).toContain("overlapping stock")
  })

  test("a symlinked default profile is refused rather than followed", () => {
    const space = workspace()
    const defaultProfile = path.join(space.home, ".local", "share", "opencode-unguarded", "profile")
    fs.mkdirSync(path.dirname(defaultProfile), { recursive: true })
    fs.symlinkSync(path.join(space.home, ".local", "share", "opencode"), defaultProfile)
    const result = evaluate(RESOLVE, { HOME: space.home })
    expect(result.stdout).toContain("REFUSED")
  })

  test("a relative or empty profile is refused", () => {
    const space = workspace()
    const relative = evaluate(RESOLVE, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: "relative/profile" })
    expect(relative.stdout).toContain("must be absolute")
    const empty = evaluate(RESOLVE, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: "" })
    expect(empty.stdout).toContain("set but empty")
  })

  test("a symlinked application directory is refused", () => {
    const space = workspace()
    fs.mkdirSync(path.join(space.profile, "data"), { recursive: true })
    fs.mkdirSync(path.join(space.root, "outside"), { recursive: true })
    fs.symlinkSync(path.join(space.root, "outside"), path.join(space.profile, "data", "opencode"))
    const result = evaluate(RESOLVE, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile })
    expect(result.stdout).toContain("REFUSED")
    expect(result.stdout).toContain("refusing symlinked")
  })

  test("a dangling symlink in the storage path is refused", () => {
    const space = workspace()
    fs.mkdirSync(space.profile, { recursive: true })
    fs.symlinkSync(path.join(space.root, "missing"), path.join(space.profile, "data"))
    const result = evaluate(RESOLVE, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile })
    expect(result.stdout).toContain("REFUSED")
    expect(result.stdout).toContain("refusing symlinked storage")
  })

  test("a symlinked descendant write target is refused", () => {
    const space = workspace()
    fs.mkdirSync(path.join(space.profile, "data", "opencode"), { recursive: true })
    fs.symlinkSync(path.join(space.root, "elsewhere"), path.join(space.profile, "data", "opencode", "log"))
    const result = evaluate(RESOLVE, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile })
    expect(result.stdout).toContain("REFUSED")
    expect(result.stdout).toContain("symlinked application storage")
  })

  test("database and sidecar links are refused", () => {
    const space = workspace()
    const data = path.join(space.profile, "data", "opencode")
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(space.root, "outside.db"), "")
    for (const suffix of ["", "-wal"]) {
      const target = path.join(data, "opencode-unguarded.db" + suffix)
      fs.rmSync(target, { force: true })
      fs.symlinkSync(path.join(space.root, "outside.db"), target)
      const script = `
const { derivativeDatabasePath } = await import(${JSON.stringify(modulePath)})
try {
  console.log("OK " + derivativeDatabasePath(${JSON.stringify(data)}))
} catch (error) {
  console.log("REFUSED " + error.message)
}
`
      const result = evaluate(script, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile })
      expect({ suffix, stdout: result.stdout }).toMatchObject({ suffix, stdout: expect.stringContaining("REFUSED") })
    }
  })

  test("ordinary databases and :memory: still work", () => {
    const space = workspace()
    const data = path.join(space.profile, "data", "opencode")
    fs.mkdirSync(data, { recursive: true })
    const script = `
const { derivativeDatabasePath } = await import(${JSON.stringify(modulePath)})
console.log(derivativeDatabasePath(${JSON.stringify(data)}))
`
    const normal = evaluate(script, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile })
    expect(normal.stdout.trim()).toBe(path.join(data, "opencode-unguarded.db"))
    const memory = evaluate(script, { HOME: space.home, OPENCODE_UNGUARDED_PROFILE: space.profile, OPENCODE_DB: ":memory:" })
    expect(memory.stdout.trim()).toBe(":memory:")
  })
})
