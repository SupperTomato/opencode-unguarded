import { expect, test } from "bun:test"
import path from "node:path"

/** Evaluate the real database-path module with the derivative flag compiled in. */
function databasePath(env: Record<string, string | undefined>) {
  const root = path.join(import.meta.dir, "..")
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      'OPENCODE_VERSION="2.1.2"',
      "--define",
      'OPENCODE_CHANNEL="unguarded"',
      '--define',
      'OPENCODE_ARTIFACT="cli"',
      "--define",
      "OPENCODE_UNGUARDED=true",
      "--define",
      'OPENCODE_UNGUARDED_REVISION="4"',
      "--define",
      'OPENCODE_UNGUARDED_UPSTREAM="a517687fde98a7329ada3ae644a01a9fc6c4e99e"',
      "-e",
      `const { databasePath } = await import(${JSON.stringify(path.join(root, "src/database-path.ts"))})
       try { console.log(JSON.stringify({ value: databasePath("/profile/data/opencode") })) }
       catch (error) { console.log(JSON.stringify({ error: String(error.message) })) }`,
    ],
    {
      cwd: root,
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
        ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const lines = child.stdout.toString().trim().split("\n").filter(Boolean)
  return JSON.parse(lines[lines.length - 1]!) as { value?: string; error?: string }
}

test("defaults to the derivative database", () => {
  expect(databasePath({})).toEqual({ value: "/profile/data/opencode/opencode-unguarded.db" })
})

test("honors :memory:", () => {
  expect(databasePath({ OPENCODE_DB: ":memory:" })).toEqual({ value: ":memory:" })
})

test("honors a plain filename override", () => {
  expect(databasePath({ OPENCODE_DB: "custom.db" })).toEqual({
    value: "/profile/data/opencode/custom.db",
  })
})

test("rejects an absolute override", () => {
  expect(databasePath({ OPENCODE_DB: "/etc/passwd" }).error).toContain("absolute path")
})

test("rejects a traversing override", () => {
  expect(databasePath({ OPENCODE_DB: "../opencode.db" }).error).toContain("must not contain")
})

test("rejects a nested override", () => {
  expect(databasePath({ OPENCODE_DB: "nested/escape.db" }).error).toContain("plain filename")
})
