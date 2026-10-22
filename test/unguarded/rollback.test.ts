import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The installer's rollback must be transaction-aware.
 *
 * A signal or failure before the previous installation is displaced must never
 * delete the live installation. These cases interrupt a real `install.sh` run
 * and inspect what remains on disk.
 */
const repoRoot = process.env.UNGUARDED_DERIVATIVE_ROOT ?? path.join(import.meta.dir, "..", "..")
const install = path.join(repoRoot, "packaging/linux-x64/install.sh")

function stage() {
  const work = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-rollback-"))
  const pkg = path.join(work, "package", "opencode-unguarded")
  fs.mkdirSync(path.join(pkg, "bin"), { recursive: true })
  fs.mkdirSync(path.join(pkg, "libexec"), { recursive: true })
  for (const file of [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "acceptance.sh",
    "collector.ts",
    "install.sh",
    "model-stub.ts",
    "telemetry-harness.sh",
    "uninstall.sh",
  ])
    fs.writeFileSync(path.join(pkg, file), `# ${file}\n`)
  fs.writeFileSync(
    path.join(pkg, "libexec", "opencode"),
    `#!${process.execPath}
const info = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "BUILD-INFO.json"), "utf8"))
console.log("opencode v" + info.version + "-unguarded." + info.derivativeRevision)
`,
    { mode: 0o755 },
  )
  fs.copyFileSync(path.join(repoRoot, "packaging/linux-x64/launcher"), path.join(pkg, "bin/opencode-unguarded"))
  fs.chmodSync(path.join(pkg, "bin/opencode-unguarded"), 0o755)
  const executable = path.join(pkg, "libexec/opencode")
  const launcher = path.join(pkg, "bin/opencode-unguarded")
  const digest = (file: string) => Bun.spawnSync(["sha256sum", file]).stdout.toString().split(" ")[0]!
  fs.writeFileSync(
    path.join(pkg, "BUILD-INFO.json"),
    JSON.stringify({
      version: "2.1.2",
      derivativeRevision: "7",
      derivative: "opencode-unguarded",
      executableSha256: digest(executable),
      launcherSha256: digest(launcher),
    }),
  )
  const archive = path.join(work, "opencode-unguarded-linux-x64.tar.gz")
  const tar = Bun.spawnSync(["tar", "-C", path.join(work, "package"), "-czf", archive, "opencode-unguarded"])
  expect(tar.exitCode).toBe(0)
  const checksum = Bun.spawnSync(["sha256sum", archive])
  fs.writeFileSync(path.join(work, "checksums.sha256"), checksum.stdout)
  return { work, archive, home: path.join(work, "home"), prefix: path.join(work, "opt", "opencode-unguarded") }
}

function installOnce(fixture: ReturnType<typeof stage>) {
  const child = Bun.spawnSync(["bash", install, "--archive", fixture.archive, "--prefix", fixture.prefix], {
    env: { HOME: fixture.home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp" },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect({ code: child.exitCode, stderr: child.stderr.toString() }).toEqual({ code: 0, stderr: "" })
}

/** Snapshot of the program tree, excluding the metadata identity written at install time. */
function snapshot(root: string) {
  const files: string[] = []
  const walk = (directory: string, prefix: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name)
      const relative = prefix === "" ? name : `${prefix}/${name}`
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) {
        walk(full, relative)
        continue
      }
      if (relative === "BUILD-INFO.json") continue
      files.push(`${relative} ${Bun.spawnSync(["sha256sum", full]).stdout.toString().split(" ")[0]}`)
    }
  }
  walk(root, "")
  return files.join("\n")
}

describe("installer transaction safety", () => {
  test("a signal while staging exists leaves the previous installation intact", async () => {
    const fixture = stage()
    installOnce(fixture)
    const before = snapshot(fixture.prefix)

    // Slow the archive copy so the run is still staging when the signal
    // arrives. The staging directory is the observable boundary: at that point
    // the previous installation has not been displaced.
    const shim = path.join(fixture.work, "shim")
    fs.mkdirSync(shim)
    const real = Bun.spawnSync(["bash", "-c", "command -v cp"]).stdout.toString().trim()
    fs.writeFileSync(
      path.join(shim, "cp"),
      `#!/bin/sh\nfor last; do :; done\nsleep 2\nexec ${JSON.stringify(real)} "$@"\n`,
      { mode: 0o755 },
    )

    const replacement = stage()
    const parent = path.dirname(fixture.prefix)
    const child = Bun.spawn(["bash", install, "--archive", replacement.archive, "--prefix", fixture.prefix], {
      env: {
        HOME: fixture.home,
        PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        TMPDIR: process.env.TMPDIR ?? "/tmp",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    // Wait until the installer has created its staging directory, then signal.
    let staged = false
    for (let attempt = 0; attempt < 300; attempt++) {
      staged = fs.readdirSync(parent).some((name) => name.startsWith(".opencode-unguarded.stage."))
      if (staged) break
      await Bun.sleep(10)
    }
    expect(staged).toBe(true)
    child.kill("SIGTERM")
    await child.exited

    // The live installation must still be there, byte for byte.
    expect(fs.existsSync(fixture.prefix)).toBe(true)
    expect(snapshot(fixture.prefix)).toBe(before)
  }, 30_000)

  test("a failure after activation restores the previous program", () => {
    const fixture = stage()
    installOnce(fixture)
    const before = snapshot(fixture.prefix)

    // A replacement whose activated executable cannot report its version.
    const broken = stage()
    fs.writeFileSync(
      path.join(broken.work, "package", "opencode-unguarded", "libexec", "opencode"),
      `#!${process.execPath}\nprocess.exit(1)\n`,
      { mode: 0o755 },
    )
    const digest = (file: string) => Bun.spawnSync(["sha256sum", file]).stdout.toString().split(" ")[0]!
    const infoPath = path.join(broken.work, "package", "opencode-unguarded", "BUILD-INFO.json")
    const info = JSON.parse(fs.readFileSync(infoPath, "utf8"))
    info.executableSha256 = digest(path.join(broken.work, "package", "opencode-unguarded", "libexec", "opencode"))
    fs.writeFileSync(infoPath, JSON.stringify(info))
    const archive = path.join(broken.work, "opencode-unguarded-linux-x64.tar.gz")
    expect(Bun.spawnSync(["tar", "-C", path.join(broken.work, "package"), "-czf", archive, "opencode-unguarded"]).exitCode).toBe(0)
    fs.writeFileSync(path.join(broken.work, "checksums.sha256"), Bun.spawnSync(["sha256sum", archive]).stdout)

    const result = Bun.spawnSync(["bash", install, "--archive", archive, "--prefix", fixture.prefix], {
      env: { HOME: fixture.home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(result.exitCode).toBe(1)
    expect(fs.existsSync(fixture.prefix)).toBe(true)
    expect(snapshot(fixture.prefix)).toBe(before)
  }, 30_000)
})
