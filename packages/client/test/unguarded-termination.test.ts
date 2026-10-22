import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Termination must be proven against the production clients with a real live
 * process. Each case compiles the derivative flag and revision in, exactly as
 * the release build does, and asks the real client to stop a registration whose
 * endpoint answers in a way that may or may not prove ownership.
 *
 * A derivative stop never signals a numeric PID: it names the instance and
 * process lifetime in an authenticated request, and the endpoint itself decides
 * whether it is that instance.
 */
const clients = [
  { name: "Promise", module: path.join(import.meta.dir, "..", "src", "promise", "service.ts") },
  { name: "Effect", module: path.join(import.meta.dir, "..", "src", "effect", "service.ts") },
]

const REVISION = "7"

const DEFINES = [
  "--define",
  "OPENCODE_UNGUARDED=true",
  "--define",
  `OPENCODE_UNGUARDED_REVISION="${REVISION}"`,
  "--define",
  'OPENCODE_UNGUARDED_UPSTREAM="a517687fde98a7329ada3ae644a01a9fc6c4e99e"',
]

/**
 * A live process that registers itself and answers `/api/info` and the
 * instance shutdown endpoint. `mode` controls whether the health response
 * proves ownership and whether the shutdown endpoint accepts the instance.
 */
const SCRIPT = `
// bun -e shifts argv, so the fixture reads its inputs from the environment.
const registration = process.env.REGISTRATION
const mode = process.env.MODE
const fs = require("node:fs")
const identity = {
  derivative: "opencode-unguarded",
  derivativeRevision: "${REVISION}",
  installation: "installation-1",
}
// The real process lifetime, so the client's stale-owner check sees this
// process as alive. A fabricated value would be classified as a reused PID.
const stat = fs.readFileSync("/proc/self/stat", "utf8")
const startTime = "linux:" + stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
let stopped = false
const finish = () => {
  fs.writeFileSync(registration + ".signal", mode === "signal" ? "SIGTERM" : "SHUTDOWN")
  process.exit(0)
}
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === "/api/lifecycle/shutdown") {
      if (mode === "no-instance") return new Response(null, { status: 404 })
      const body = await request.json().catch(() => ({}))
      // Refuse unless the request names this exact instance and lifetime.
      if (body.id !== "owner" || body.installation !== "installation-1" || body.startTime !== startTime)
        return Response.json({ message: "the requested service instance is not running here" }, { status: 409 })
      if (stopped) return new Response(null, { status: 204 })
      stopped = true
      setTimeout(finish, 50)
      return new Response(null, { status: 204 })
    }
    if (path !== "/api/info") return new Response(null, { status: 404 })
    if (mode === "not-found") return new Response(null, { status: 404 })
    return Response.json({ version: "2.1.2", pid: process.pid, startTime, ...identity })
  },
})
process.on("SIGTERM", finish)
fs.writeFileSync(
  registration,
  JSON.stringify({
    id: "owner",
    version: "2.1.2",
    ...identity,
    startTime,
    url: server.url.toString(),
    pid: process.pid,
    password: "private",
  }),
)
await new Promise(() => {})
`

async function victim(mode: "not-found" | "matching" | "no-instance" | "signal") {
  const directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "unguarded-termination-"))
  const registration = path.join(directory, "service-unguarded.json")
  const child = Bun.spawn([process.execPath, "-e", SCRIPT], {
    env: { ...process.env, REGISTRATION: registration, MODE: mode },
    stdout: "ignore",
    stderr: "inherit",
  })
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await Bun.file(registration).exists()) break
    await Bun.sleep(5)
  }
  if (!(await Bun.file(registration).exists())) throw new Error(`fixture did not register: ${registration}`)
  return {
    registration,
    child,
    signal: () => Bun.file(registration + ".signal").exists(),
    async dispose() {
      child.kill("SIGKILL")
      await child.exited
      await rm(directory, { recursive: true, force: true })
    },
  }
}

/** Run the real client's stop against a registration, with the caller identity. */
async function stop(registration: string, client: (typeof clients)[number], caller = "installation-1") {
  const source =
    client.name === "Promise"
      ? `const { stop } = await import(${JSON.stringify(client.module)})
await stop({ file: ${JSON.stringify(registration)}, installation: ${JSON.stringify(caller)} })`
      : `const { Service } = await import(${JSON.stringify(client.module)})
const { Effect } = await import("effect")
const { NodeFileSystem } = await import("@effect/platform-node")
const result = await Effect.runPromise(
  Service.stop({ file: ${JSON.stringify(registration)}, installation: ${JSON.stringify(caller)} }).pipe(
    Effect.provide(NodeFileSystem.layer),
  ),
)`
  const child = Bun.spawn(
    [
      process.execPath,
      ...DEFINES,
      "-e",
      `
try {
  ${source}
  console.log("STOPPED")
} catch (error) {
  console.log("REFUSED " + error.message)
}
`,
    ],
    { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toMatchObject({ code: 0 })
  return stdout
}

for (const client of clients) {
  test(`${client.name}: a 404 health response never authorizes stopping the registered PID`, async () => {
    const owner = await victim("not-found")
    try {
      const output = await stop(owner.registration, client)
      expect(output).toContain("REFUSED")
      expect(output).toContain("not-found")
      expect(owner.child.exitCode).toBe(null)
      expect(await owner.signal()).toBe(false)
    } finally {
      await owner.dispose()
    }
  }, 30_000)

  test(`${client.name}: a proven owner is stopped through instance control, not a signal`, async () => {
    const owner = await victim("matching")
    try {
      // Awaiting `exited` lets Bun reap the child; without it the child stays a
      // zombie and still answers kill(pid, 0), which is a harness artifact.
      const [output] = await Promise.all([stop(owner.registration, client), owner.child.exited])
      expect(output).toBe("STOPPED\n")
      // The daemon reported a shutdown request; it was never signalled.
      expect(await owner.signal()).toBe(true)
      expect(await Bun.file(owner.registration + ".signal").text()).toBe("SHUTDOWN")
    } finally {
      await owner.dispose()
    }
  }, 30_000)

  test(`${client.name}: a caller from another installation never stops the owner`, async () => {
    const owner = await victim("matching")
    try {
      const output = await stop(owner.registration, client, "installation-2")
      expect(output).toContain("REFUSED")
      expect(output).toContain("installation-mismatch")
      expect(owner.child.exitCode).toBe(null)
      expect(await owner.signal()).toBe(false)
    } finally {
      await owner.dispose()
    }
  }, 30_000)

  test(`${client.name}: a daemon without instance control is refused, not signalled`, async () => {
    const owner = await victim("no-instance")
    try {
      const output = await stop(owner.registration, client)
      expect(output).toContain("REFUSED")
      expect(output).toContain("instance identity")
      expect(owner.child.exitCode).toBe(null)
      expect(await owner.signal()).toBe(false)
    } finally {
      await owner.dispose()
    }
  }, 30_000)

  test(`${client.name}: a stale record belonging to another installation is preserved`, async () => {
    // No process is listening; the recorded PID is one that cannot belong to it
    // any more, so cleanup is the only operation that could touch the file.
    const directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "unguarded-stale-"))
    const registration = path.join(directory, "service-unguarded.json")
    const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"])
    await dead.exited
    await Bun.write(
      registration,
      JSON.stringify({
        id: "owner",
        version: "2.1.2",
        derivative: "opencode-unguarded",
        derivativeRevision: REVISION,
        installation: "another-installation",
        url: "http://127.0.0.1:1/",
        pid: dead.pid,
        password: "private",
      }),
    )
    try {
      const output = await stop(registration, client)
      expect(output).toContain("REFUSED")
      expect(output).toContain("different build or installation")
      expect(await Bun.file(registration).exists()).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test(`${client.name}: an owned stale record is removed without signalling`, async () => {
    const directory = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "unguarded-stale-own-"))
    const registration = path.join(directory, "service-unguarded.json")
    const dead = Bun.spawn([process.execPath, "-e", "process.exit(0)"])
    await dead.exited
    await Bun.write(
      registration,
      JSON.stringify({
        id: "owner",
        version: "2.1.2",
        derivative: "opencode-unguarded",
        derivativeRevision: REVISION,
        installation: "installation-1",
        url: "http://127.0.0.1:1/",
        pid: dead.pid,
        password: "private",
      }),
    )
    try {
      const output = await stop(registration, client)
      expect(output).toBe("STOPPED\n")
      expect(await Bun.file(registration).exists()).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 30_000)

  test(`${client.name}: discovery requires the caller's installation`, async () => {
    const owner = await victim("matching")
    try {
      const source =
        client.name === "Promise"
          ? `const { discover } = await import(${JSON.stringify(client.module)})
const found = await discover({ file: ${JSON.stringify(owner.registration)}, installation: "installation-1" })
const foreign = await discover({ file: ${JSON.stringify(owner.registration)}, installation: "installation-2" })
console.log(JSON.stringify({ found: found?.url ?? null, foreign: foreign?.url ?? null }))`
          : `const { Service } = await import(${JSON.stringify(client.module)})
const { Effect } = await import("effect")
const { NodeFileSystem } = await import("@effect/platform-node")
const run = (installation) => Effect.runPromise(
  Service.discover({ file: ${JSON.stringify(owner.registration)}, installation }).pipe(Effect.provide(NodeFileSystem.layer)),
)
const found = await run("installation-1")
const foreign = await run("installation-2")
console.log(JSON.stringify({ found: found?.url ?? null, foreign: foreign?.url ?? null }))`
      const child = Bun.spawn([process.execPath, ...DEFINES, "-e", source], {
        cwd: path.join(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
      expect(code).toBe(0)
      const result = JSON.parse(stdout.trim()) as { found: string | null; foreign: string | null }
      expect(result.found).not.toBeNull()
      expect(result.foreign).toBeNull()
    } finally {
      await owner.dispose()
    }
  }, 30_000)
}
