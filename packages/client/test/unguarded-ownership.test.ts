import { expect, test } from "bun:test"
import path from "node:path"

/**
 * Evaluated with the derivative flag and revision compiled in, exactly as the
 * release build compiles them. A local HTTP server stands in for a registered
 * owner, so the probe performs real requests instead of replacing fetch.
 */
function evaluate(source: string) {
  const root = path.join(import.meta.dir, "..")
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      "OPENCODE_UNGUARDED=true",
      "--define",
      'OPENCODE_UNGUARDED_REVISION="5"',
      "--define",
      'OPENCODE_UNGUARDED_UPSTREAM="a517687fde98a7329ada3ae644a01a9fc6c4e99e"',
      "-e",
      source,
    ],
    { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" },
  )
  return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() }
}

const IDENTITY = {
  derivative: "opencode-unguarded",
  derivativeRevision: "5",
  installation: "installation-1",
}

/** Probe a real local endpoint that answers with `body` and `status`. */
const probe = (registration: object, body: object, status = 200, caller = "installation-1") => `
const { probeResult, decide, ownedByThisBuild, same } = await import(${JSON.stringify(
  path.join(import.meta.dir, "../src/service-probe.ts"),
)})
const server = Bun.serve({
  port: 0,
  fetch: () => new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} }),
})
const info = { ...${JSON.stringify(registration)}, url: server.url.toString() }
try {
  const result = await probeResult(info, 2000, { installation: ${JSON.stringify(caller)} })
  console.log(JSON.stringify({
    owned: ownedByThisBuild(info),
    status: result.status,
    reason: result.reason ?? null,
    decision: result.service ? decide(result.service, { version: "2.1.2", installation: ${JSON.stringify(caller)} })._tag : null,
    same: result.service ? same(info, result.service.info) : null,
  }))
} finally {
  server.stop(true)
}
`

const live = (extra: object = {}) => ({ pid: 4242, version: "2.1.2", ...IDENTITY, ...extra })
const registration = (extra: object = {}) => ({ id: "one", ...live(extra), password: "x" })

test("a matching derivative owner is accepted and reused", () => {
  const result = evaluate(probe(registration(), live()))
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ owned: true, status: "verified", decision: "reuse" })
})

test("a stock registration at the same version is never adopted", () => {
  const result = evaluate(
    probe({ id: "stock", pid: 4242, version: "2.1.2", password: "x" }, { pid: 4242, version: "2.1.2" }),
  )
  // Stock has no derivative identity at either end, so the probe refuses it
  // before any version comparison.
  expect(JSON.parse(result.stdout)).toMatchObject({ owned: false, status: "unverified", reason: "build-mismatch" })
})

test("an older derivative revision is not silently reused", () => {
  const result = evaluate(
    probe(registration({ derivativeRevision: "4" }), live({ derivativeRevision: "4" })),
  )
  // The probe refuses the live owner, so `ensure` reports an ownership
  // conflict instead of spawning a contender against the same port.
  expect(JSON.parse(result.stdout)).toMatchObject({ owned: false, status: "unverified", decision: null })
})

test("a registration without a revision cannot prove ownership", () => {
  const result = evaluate(
    probe(
      { id: "legacy", pid: 4242, version: "2.1.2", derivative: "opencode-unguarded", password: "x" },
      live(),
    ),
  )
  expect(JSON.parse(result.stdout)).toMatchObject({ owned: false, status: "unverified", reason: "build-mismatch" })
})

test("the caller's own installation is required, not just agreement", () => {
  // Registration and endpoint agree on installation-1, but this caller is
  // installation-2. Agreement between the two files proves nothing about who
  // is asking, so the service must not be adopted or stopped.
  const result = evaluate(probe(registration(), live(), 200, "installation-2"))
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "installation-mismatch" })
})

test("a caller that cannot name its installation is refused", () => {
  const result = evaluate(`
const { probeResult } = await import(${JSON.stringify(
    path.join(import.meta.dir, "../src/service-probe.ts"),
  )})
const server = Bun.serve({ port: 0, fetch: () => Response.json(${JSON.stringify(live())}) })
const info = { ...${JSON.stringify(registration())}, url: server.url.toString() }
try {
  const result = await probeResult(info, 2000)
  console.log(JSON.stringify({ status: result.status, reason: result.reason ?? null }))
} finally {
  server.stop(true)
}
`)
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "installation-mismatch" })
})

test("a live owner from another installation is rejected", () => {
  const result = evaluate(probe(registration(), live({ installation: "installation-2" })))
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "installation-mismatch" })
})

test("a live owner that is not the registered build is rejected", () => {
  const result = evaluate(probe(registration(), live({ derivative: "opencode" })))
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "build-mismatch" })
})

test("a registration whose live owner reports a different PID is rejected", () => {
  const result = evaluate(probe(registration(), live({ pid: 9999 })))
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "pid-mismatch" })
})

test("a 404 health endpoint never proves ownership", () => {
  const result = evaluate(probe(registration(), {}, 404))
  // The critical assertion: no service object, so no caller can conclude this
  // endpoint is the registered owner, and termination refuses to signal.
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "incompatible", decision: null })
})

test("an unauthorized health response proves nothing", () => {
  const result = evaluate(probe(registration(), {}, 401))
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "unauthorized" })
})

test("a malformed health response proves nothing", () => {
  const result = evaluate(probe(registration(), { hello: "world" }))
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "malformed" })
})

test("an unreachable endpoint proves nothing", () => {
  const result = evaluate(`
const { probeResult } = await import(${JSON.stringify(path.join(import.meta.dir, "../src/service-probe.ts"))})
const result = await probeResult(
  { ...${JSON.stringify(registration())}, url: "http://127.0.0.1:1" },
  500,
)
console.log(JSON.stringify({ status: result.status, reason: result.reason ?? null }))
`)
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified", reason: "unreachable" })
})
