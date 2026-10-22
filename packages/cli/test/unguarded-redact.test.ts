import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Credential-bearing arguments must never reach the CLI log.
 *
 * The startup and failure records include the argument list, so the redactor is
 * exercised directly against representative commands. Distinctive sentinel
 * values make a leaked secret unambiguous.
 */
const { redactArguments, isReadOnlyInvocation } = await import(
  path.join(import.meta.dir, "..", "src", "util", "redact.ts")
)

const SECRET = "sentinel-secret-value-9f3a"

describe("argument redaction", () => {
  test("service set password hides the value but keeps the command", () => {
    const args = redactArguments(["service", "set", "password", SECRET])
    expect(args).toEqual(["service", "set", "password", "<redacted>"])
    expect(args.join(" ")).not.toContain(SECRET)
  })

  test("service set env keeps the variable name and hides the value", () => {
    const args = redactArguments(["service", "set", "env", "OPENAI_API_KEY", SECRET])
    expect(args).toEqual(["service", "set", "env", "OPENAI_API_KEY", "<redacted>"])
  })

  test("auth login hides answer values but keeps the field names", () => {
    const args = redactArguments(["auth", "login", "openai", "--answer", "key=" + SECRET, "--answer", "org=acme"])
    expect(args.join(" ")).not.toContain(SECRET)
    expect(args.join(" ")).toContain("key=<redacted>")
    expect(args.join(" ")).toContain("org=<redacted>")
    expect(args.join(" ")).toContain("auth login openai")
  })

  test("sensitive flags hide both separate and inline values", () => {
    expect(redactArguments(["run", "--password", SECRET])).toEqual(["run", "--password", "<redacted>"])
    expect(redactArguments(["run", `--password=${SECRET}`])).toEqual(["run", "--password=<redacted>"])
    expect(redactArguments(["run", "--token", SECRET, "--model", "x"])).toEqual([
      "run",
      "--token",
      "<redacted>",
      "--model",
      "x",
    ])
  })

  test("ordinary prompts and flags are preserved", () => {
    expect(redactArguments(["run", "explain", "--dry-run"])).toEqual(["run", "explain", "--dry-run"])
    expect(redactArguments(["uninstall", "--dry-run"])).toEqual(["uninstall", "--dry-run"])
  })

  test("a prompt that mentions a secret-looking flag is not mangled", () => {
    const args = redactArguments(["run", "why does --password matter?"])
    expect(args.join(" ")).toContain("why does --password matter?")
  })
})

describe("startup logging", () => {
  test("a real CLI run never writes a credential operand to its log", async () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-log-"))
    const secret = "sentinel-secret-9f3a2b"
    const profile = path.join(directory, "profile")
    const home = path.join(directory, "home")
    fs.mkdirSync(home, { recursive: true })
    try {
      // A command that carries a secret and then fails, so both the startup
      // record and the failure record are written.
      const child = Bun.spawn(
        [
          process.execPath,
          path.join(import.meta.dir, "..", "src", "index.ts"),
          "service",
          "set",
          "password",
          secret,
          "--definitely-not-a-flag",
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            OPENCODE_UNGUARDED_PROFILE: profile,
            TMPDIR: directory,
            OPENCODE_UNGUARDED: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      await child.exited
      // Source runs use the local channel, whose logger writes below the
      // stock XDG data root; the packaged build writes inside the profile.
      const logs = [path.join(home, ".local", "share", "opencode", "log"), path.join(profile, "data", "opencode", "log")]
        .filter((directory) => fs.existsSync(directory))
        .flatMap((directory) =>
          fs.readdirSync(directory).map((name) => fs.readFileSync(path.join(directory, name), "utf8")),
        )
        .join("\n")
      expect(logs).not.toContain(secret)
      expect(logs.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("saved service environment repair", () => {
  test("a rejected saved value can be removed with the documented command", async () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-env-"))
    const home = path.join(directory, "home")
    const profile = path.join(directory, "profile")
    const config = path.join(profile, "config", "opencode", "service-unguarded.json")
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, JSON.stringify({ env: { OPENCODE_DB: "escape.db" } }))
    const defines = [
      "--define",
      "OPENCODE_UNGUARDED=true",
      "--define",
      'OPENCODE_CHANNEL="unguarded"',
      "--define",
      'OPENCODE_UNGUARDED_REVISION="8"',
      "--define",
      'OPENCODE_UNGUARDED_UPSTREAM="a517687f"',
    ]
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, ...defines, path.join(import.meta.dir, "..", "src", "index.ts"), ...args], {
        env: { ...process.env, HOME: home, OPENCODE_UNGUARDED_PROFILE: profile, TMPDIR: directory },
        stdout: "pipe",
        stderr: "pipe",
      })
    try {
      const refused = run("service", "status")
      expect(refused.stdout.toString() + refused.stderr.toString()).toContain("refusing saved service environment")

      const removed = run("service", "unset", "env", "OPENCODE_DB")
      expect(removed.exitCode).toBe(0)
      expect(JSON.parse(fs.readFileSync(config, "utf8"))).toEqual({})

      // Normal operation resumes with the offending value gone.
      const status = run("service", "status")
      expect(status.stdout.toString() + status.stderr.toString()).not.toContain("refusing saved service environment")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("dry-run scoping", () => {
  test("only the uninstall preview is read-only", () => {
    expect(isReadOnlyInvocation(["uninstall", "--dry-run"])).toBe(true)
    expect(isReadOnlyInvocation(["uninstall", "--force", "--dry-run"])).toBe(true)
    expect(isReadOnlyInvocation(["run", "explain --dry-run"])).toBe(false)
    expect(isReadOnlyInvocation(["service", "status", "--dry-run"])).toBe(false)
  })
})
