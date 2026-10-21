import { expect, test } from "bun:test"
import path from "node:path"

/**
 * Evaluated with the derivative flag compiled in, exactly as the release build
 * compiles it. The probe is the shared discovery path for both clients.
 */
function evaluate(source: string, env: Record<string, string> = {}) {
  const root = path.join(import.meta.dir, "..")
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      "OPENCODE_UNGUARDED=true",
      "-e",
      source,
    ],
    { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  )
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

const probe = (info: string, body: string) => `
const { probeResult, decide, ownedByThisBuild } = await import(${JSON.stringify(
  path.join(import.meta.dir, "../src/service-probe.ts"),
)})
globalThis.fetch = async () => new Response(JSON.stringify(${body}), { status: 200 })
const info = ${info}
const result = await probeResult(info)
console.log(JSON.stringify({
  owned: ownedByThisBuild(info),
  accepted: result.service !== undefined,
  decision: result.service ? decide(result.service, { version: "2.1.2" })._tag : null,
}))
`

test("a derivative registration is accepted", () => {
  const result = evaluate(
    probe(
      `{ id: "own", pid: 4242, version: "2.1.2", derivative: "opencode-unguarded", url: "http://127.0.0.1:47499" }`,
      `{ pid: 4242, version: "2.1.2" }`,
    ),
  )
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ owned: true, accepted: true, decision: "reuse" })
})

test("a stock registration at the same version is not adopted", () => {
  const result = evaluate(
    probe(
      `{ id: "stock", pid: 4242, version: "2.1.2", url: "http://127.0.0.1:49374" }`,
      `{ pid: 4242, version: "2.1.2" }`,
    ),
  )
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ owned: false, accepted: true, decision: "fail" })
})

test("a registration claiming another distribution is not adopted", () => {
  const result = evaluate(
    probe(
      `{ id: "other", pid: 4242, version: "2.1.2", derivative: "opencode", url: "http://127.0.0.1:49374" }`,
      `{ pid: 4242, version: "2.1.2" }`,
    ),
  )
  expect(JSON.parse(result.stdout)).toEqual({ owned: false, accepted: true, decision: "fail" })
})

test("a registration whose live owner reports a different PID is rejected", () => {
  const result = evaluate(
    probe(
      `{ id: "stale", pid: 4242, version: "2.1.2", derivative: "opencode-unguarded", url: "http://127.0.0.1:47499" }`,
      `{ pid: 9999, version: "2.1.2" }`,
    ),
  )
  expect(JSON.parse(result.stdout)).toEqual({ owned: true, accepted: false, decision: null })
})
