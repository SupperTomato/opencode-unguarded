import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")
const install = path.join(repoRoot, "packaging/linux-x64/install.sh")
const uninstall = path.join(repoRoot, "packaging/linux-x64/uninstall.sh")

/** Build a fake archive with the layout and identity a real release has. */
function makeArchive(options: { metadata?: Record<string, string>; escaping?: boolean; symlink?: boolean } = {}) {
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-install-"))
  const stage = path.join(work, "package", "opencode-unguarded")
  fs.mkdirSync(path.join(stage, "bin"), { recursive: true })
  fs.mkdirSync(path.join(stage, "libexec"), { recursive: true })
  fs.writeFileSync(
    path.join(stage, "libexec", "opencode"),
    `#!${process.execPath}\nconsole.log("opencode v2.1.2-unguarded.3")\n`,
    { mode: 0o755 },
  )
  fs.copyFileSync(path.join(repoRoot, "packaging/linux-x64/launcher"), path.join(stage, "bin", "opencode-unguarded"))
  fs.chmodSync(path.join(stage, "bin", "opencode-unguarded"), 0o755)
  fs.writeFileSync(
    path.join(stage, "BUILD-INFO.json"),
    JSON.stringify({ version: "2.1.2", derivativeRevision: "3", derivative: "opencode-unguarded", ...options.metadata }),
  )
  if (options.symlink) fs.symlinkSync("/etc/passwd", path.join(stage, "escape"))
  const archive = path.join(work, "opencode-unguarded-linux-x64.tar.gz")
  const tar = Bun.spawnSync(["tar", "-C", path.join(work, "package"), "-czf", archive, "opencode-unguarded"])
  expect(tar.exitCode).toBe(0)
  if (options.escaping) {
    fs.writeFileSync(path.join(work, "package", "escape.txt"), "x")
    Bun.spawnSync(["tar", "-C", path.join(work, "package"), "-czf", archive, "opencode-unguarded", "--transform", "s|escape.txt|../escape.txt|", "escape.txt"])
  }
  const checksum = Bun.spawnSync(["sha256sum", archive])
  fs.writeFileSync(path.join(work, "checksums.sha256"), checksum.stdout)
  return { work, archive, home: path.join(work, "home"), prefix: path.join(work, "opt", "opencode-unguarded") }
}

function run(script: string, args: string[], env: Record<string, string>) {
  const child = Bun.spawnSync(["bash", script, ...args], {
    env: { HOME: env.HOME, PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

describe("candidate installation", () => {
  test("installs beside stock and links only its own command", () => {
    const fixture = makeArchive()
    fs.mkdirSync(path.join(fixture.home, ".local/bin"), { recursive: true })
    const stock = path.join(fixture.home, ".local/bin/opencode")
    fs.writeFileSync(stock, "stock")
    const result = run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home })
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(fs.existsSync(path.join(fixture.prefix, "libexec/opencode"))).toBe(true)
    expect(fs.readFileSync(stock, "utf8")).toBe("stock")
    const link = path.join(fixture.home, ".local/bin/opencode-unguarded")
    expect(fs.readlinkSync(link)).toBe(path.join(fixture.prefix, "bin/opencode-unguarded"))
  })

  test("refuses an archive whose embedded revision disagrees with its metadata", () => {
    const fixture = makeArchive({ metadata: { derivativeRevision: "9" } })
    const result = run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("does not match metadata")
    expect(fs.existsSync(fixture.prefix)).toBe(false)
  })

  test("refuses an archive with symbolic links", () => {
    const fixture = makeArchive({ symlink: true })
    const result = run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("symbolic links")
  })

  test("refuses an archive with traversing members", () => {
    const fixture = makeArchive({ escaping: true })
    const result = run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/absolute or traversing/)
  })

  test("refuses to replace an unrelated command link", () => {
    const fixture = makeArchive()
    const bindir = path.join(fixture.home, ".local/bin")
    fs.mkdirSync(bindir, { recursive: true })
    fs.symlinkSync("/usr/bin/env", path.join(bindir, "opencode-unguarded"))
    const result = run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("unrelated command")
    expect(fs.readlinkSync(path.join(bindir, "opencode-unguarded"))).toBe("/usr/bin/env")
  })

  test("replacement keeps a rollback copy", () => {
    const fixture = makeArchive()
    expect(run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix, "--no-link"], { HOME: fixture.home }).exitCode).toBe(0)
    const result = run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix, "--no-link"], { HOME: fixture.home })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("previous installation kept at")
  })

  test("rejects a relative prefix", () => {
    const fixture = makeArchive()
    const result = run(install, ["--archive", fixture.archive, "--prefix", "relative"], { HOME: fixture.home })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("absolute path")
  })
})

describe("candidate uninstall", () => {
  test("removes the installation and keeps profile data", () => {
    const fixture = makeArchive()
    expect(run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home }).exitCode).toBe(0)
    const profile = path.join(fixture.home, ".local/share/opencode-unguarded/profile")
    fs.mkdirSync(path.join(profile, "data"), { recursive: true })
    fs.writeFileSync(path.join(profile, "data", "session.db"), "data")
    const stock = path.join(fixture.home, ".local/bin/opencode")
    fs.writeFileSync(stock, "stock")

    const result = run(uninstall, ["--prefix", fixture.prefix, "--force"], { HOME: fixture.home })
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(fs.existsSync(fixture.prefix)).toBe(false)
    expect(fs.existsSync(path.join(profile, "data", "session.db"))).toBe(true)
    expect(fs.readFileSync(stock, "utf8")).toBe("stock")
    expect(fs.existsSync(path.join(fixture.home, ".local/bin/opencode-unguarded"))).toBe(false)
  })

  test("dry run changes nothing", () => {
    const fixture = makeArchive()
    expect(run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix], { HOME: fixture.home }).exitCode).toBe(0)
    const result = run(uninstall, ["--prefix", fixture.prefix, "--dry-run"], { HOME: fixture.home })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Dry run")
    expect(fs.existsSync(fixture.prefix)).toBe(true)
  })

  test("refuses a directory that is not a candidate installation", () => {
    const fixture = makeArchive()
    fs.mkdirSync(fixture.prefix, { recursive: true })
    const result = run(uninstall, ["--prefix", fixture.prefix, "--force"], { HOME: fixture.home })
    expect(result.exitCode).toBe(1)
    expect(fs.existsSync(fixture.prefix)).toBe(true)
  })

  test("leaves a command link that points elsewhere", () => {
    const fixture = makeArchive()
    expect(run(install, ["--archive", fixture.archive, "--prefix", fixture.prefix, "--no-link"], { HOME: fixture.home }).exitCode).toBe(0)
    const bindir = path.join(fixture.home, ".local/bin")
    fs.mkdirSync(bindir, { recursive: true })
    fs.symlinkSync("/usr/bin/env", path.join(bindir, "opencode-unguarded"))
    const result = run(uninstall, ["--prefix", fixture.prefix, "--force"], { HOME: fixture.home })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Left")
    expect(fs.readlinkSync(path.join(bindir, "opencode-unguarded"))).toBe("/usr/bin/env")
  })
})
