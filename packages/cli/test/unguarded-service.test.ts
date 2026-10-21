import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

/**
 * The derivative must never adopt a stock registration. These tests exercise
 * the real migration helpers and the real registration file names, with the
 * derivative flag compiled in the same way the release build compiles it.
 */

const script = path.join(import.meta.dir, "fixture/unguarded-service.ts")

function run(operation: string) {
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
      'OPENCODE_UNGUARDED_REVISION="3"',
      "--define",
      'OPENCODE_UNGUARDED_UPSTREAM="a517687fde98a7329ada3ae644a01a9fc6c4e99e"',
      script,
      operation,
    ],
    { cwd: path.join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
  )
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
    output: child.stdout
      .toString()
      .split("\n")
      .filter((line) => line.startsWith("RESULT "))
      .map((line) => JSON.parse(line.slice(7)) as unknown),
  }
}

test("the derivative uses its own registration file and port", () => {
  const result = run("identity")
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(result.output).toEqual([{ filename: "service-unguarded.json", port: 47499, channel: "unguarded" }])
})

test("a stock registration with the same version is never migrated", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-service-stock-"))
  try {
    const legacy = path.join(root, "service.json")
    const target = path.join(root, "service-unguarded.json")
    await fs.writeFile(
      legacy,
      JSON.stringify({
        id: "stock",
        version: "2.1.2",
        url: "http://127.0.0.1:49374",
        pid: process.pid,
        password: "stock",
      }),
    )
    const result = run(`migrate:${legacy}:${target}`)
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(result.output).toEqual([{ migrated: false, legacy: true }])
    await expect(Bun.file(target).exists()).resolves.toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a derivative registration migrates only when marked", async () => {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "unguarded-service-own-"))
  try {
    const legacy = path.join(root, "service-legacy.json")
    const target = path.join(root, "service-unguarded.json")
    await fs.writeFile(
      legacy,
      JSON.stringify({
        id: "derivative",
        version: "2.1.2",
        derivative: "opencode-unguarded",
        url: "http://127.0.0.1:47499",
        pid: process.pid,
        password: "own",
      }),
    )
    const result = run(`migrate:${legacy}:${target}`)
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(result.output).toEqual([{ migrated: true, legacy: true }])
    await expect(Bun.file(target).exists()).resolves.toBe(true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("a matching version alone does not satisfy the ownership predicate", () => {
  expect(
    ServiceConfig.registrationBelongsToChannel({ derivative: undefined }, ServiceConfig.DERIVATIVE_CHANNEL),
  ).toBe(false)
  expect(
    ServiceConfig.registrationBelongsToChannel({ derivative: "opencode-unguarded" }, ServiceConfig.DERIVATIVE_CHANNEL),
  ).toBe(true)
  // A stock channel accepts any registration, so the helper must not break stock behavior.
  expect(ServiceConfig.registrationBelongsToChannel({ derivative: undefined }, "latest")).toBe(true)
})
