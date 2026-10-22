import { describe, expect, test } from "bun:test"
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

describe("dry-run scoping", () => {
  test("only the uninstall preview is read-only", () => {
    expect(isReadOnlyInvocation(["uninstall", "--dry-run"])).toBe(true)
    expect(isReadOnlyInvocation(["uninstall", "--force", "--dry-run"])).toBe(true)
    expect(isReadOnlyInvocation(["run", "explain --dry-run"])).toBe(false)
    expect(isReadOnlyInvocation(["service", "status", "--dry-run"])).toBe(false)
  })
})
