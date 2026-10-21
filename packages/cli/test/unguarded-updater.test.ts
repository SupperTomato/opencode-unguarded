import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Run the real updater service with the derivative flag compiled in, exactly
 * as the release binary compiles it, and observe every spawn attempt.
 */
function runUpdater() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unguarded-updater-"))
  const executable = path.join(root, "opt/opencode-unguarded/libexec/opencode")
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, "binary")
  for (const name of ["data", "cache", "config", "state", "tmp", "bin", "log", "repos"]) fs.mkdirSync(path.join(root, name))
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      "OPENCODE_VERSION=\"2.1.2\"",
      "--define",
      "OPENCODE_CHANNEL=\"unguarded\"",
      "--define",
      "OPENCODE_ARTIFACT=\"cli\"",
      "--define",
      "OPENCODE_UNGUARDED=true",
      "--define",
      "OPENCODE_UNGUARDED_REVISION=\"test\"",
      "--define",
      "OPENCODE_UNGUARDED_UPSTREAM=\"a517687fde98a7329ada3ae644a01a9fc6c4e99e\"",
      path.join(import.meta.dir, "fixture/unguarded-updater.ts"),
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, UPDATER_FIXTURE_ROOT: root, UPDATER_FIXTURE_EXECUTABLE: executable },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = child.stdout.toString()
  const stderr = child.stderr.toString()
  const events = stdout
    .split("\n")
    .filter((line) => line.startsWith("EVENT "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, any>)
  return { exitCode: child.exitCode, stdout, stderr, events, root }
}

describe("derivative updater boundary", () => {
  test("every route refuses or reports unavailable, and nothing is spawned", () => {
    const result = runUpdater()
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    const spawns = result.events.filter((event) => "spawn" in event)
    expect(spawns).toEqual([])
    for (const method of ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew", "winget"]) {
      const event = result.events.find((item) => item.label === `upgrade:${method}`)
      expect({ method, failed: event?.failed }).toEqual({ method, failed: true })
      expect(String(event?.message)).toContain("does not self-update")
    }
    const failures = ["latest", "apply"].map((label) => result.events.find((item) => item.label === label))
    for (const event of failures) expect(event?.failed).toBe(true)
    expect(result.events.find((item) => item.label === "run")?.value).toBe("undefined")
    const check = result.events.find((item) => item.label === "check")
    expect(check?.failed).toBe(false)
    expect(check?.value?.type).toBe("unavailable")
    expect(check?.value?.message).toContain("opencode-unguarded")
    expect(result.events.find((item) => item.removal !== undefined)?.removal).toBe("undefined")
    expect(result.events.find((item) => item.removalCurl !== undefined)?.removalCurl).toBe("undefined")
  })

  test("a stock build is not restricted by the same service", () => {
    const result = runUpdaterUnrestricted()
    const spawns = result.events.filter((event) => "spawn" in event)
    expect(spawns.length).toBeGreaterThan(0)
    const upgrade = result.events.find((item) => item.label === "upgrade:npm")
    expect(upgrade?.failed).toBe(false)
  })
})

function runUpdaterUnrestricted() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "stock-updater-"))
  const executable = path.join(root, "opt/opencode/libexec/opencode")
  fs.mkdirSync(path.dirname(executable), { recursive: true })
  fs.writeFileSync(executable, "binary")
  for (const name of ["data", "cache", "config", "state", "tmp", "bin", "log", "repos"]) fs.mkdirSync(path.join(root, name))
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      "OPENCODE_VERSION=\"2.1.2\"",
      "--define",
      "OPENCODE_CHANNEL=\"latest\"",
      "--define",
      "OPENCODE_ARTIFACT=\"cli\"",
      "--define",
      "OPENCODE_UNGUARDED=false",
      "--define",
      'OPENCODE_UNGUARDED_REVISION="source"',
      "--define",
      'OPENCODE_UNGUARDED_UPSTREAM="unknown"',
      path.join(import.meta.dir, "fixture/unguarded-updater.ts"),
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, UPDATER_FIXTURE_ROOT: root, UPDATER_FIXTURE_EXECUTABLE: executable },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = child.stdout.toString()
  return {
    stdout,
    events: stdout
      .split("\n")
      .filter((line) => line.startsWith("EVENT "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, any>),
  }
}
