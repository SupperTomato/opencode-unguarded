import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Termination must be proven against the production clients with a real live
 * process. Each case compiles the derivative flag and revision in, exactly as
 * the release build does, and asks the real client to stop a registration whose
 * endpoint answers in a way that may or may not prove ownership.
 */
const clients = [
  { name: "Promise", module: path.join(import.meta.dir, "..", "src", "promise", "service.ts") },
  { name: "Effect", module: path.join(import.meta.dir, "..", "src", "effect", "service.ts") },
]

const DEFINES = [
  "--define",
  "OPENCODE_UNGUARDED=true",
  "--define",
  'OPENCODE_UNGUARDED_REVISION="5"',
  "--define",
  'OPENCODE_UNGUARDED_UPSTREAM="a517687fde98a7329ada3ae644a01a9fc6c4e99e"',
]

/** A live process that registers itself and answers /api/info as instructed. */
const SCRIPT = `
// bun -e shifts argv, so the fixture reads its inputs from the environment.
const registration = process.env.REGISTRATION
const mode = process.env.MODE
const fs = require("node:fs")
const identity = {
  derivative: "opencode-unguarded",
  derivativeRevision: "5",
  installation: "installation-1",
}
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path !== "/api/info") return new Response(null, { status: 404 })
    if (mode === "not-found") return new Response(null, { status: 404 })
    return Response.json({ version: "2.1.2", pid: process.pid, ...identity })
  },
})
process.on("SIGTERM", () => {
  fs.writeFileSync(registration + ".signal", "SIGTERM")
  process.exit(0)
})
fs.writeFileSync(
  registration,
  JSON.stringify({
    id: "owner",
    version: "2.1.2",
    ...identity,
    url: server.url.toString(),
    pid: process.pid,
    password: "private",
  }),
)
await new Promise(() => {})
`

async function victim(mode: "not-found" | "matching") {
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
  test(`${client.name}: a 404 health response never authorizes signalling the registered PID`, async () => {
    const owner = await victim("not-found")
    try {
      const output = await stop(owner.registration, client)
      expect(output).toContain("REFUSED")
      expect(output).toContain("not-found")
      // The unrelated process is still alive and received no signal.
      expect(owner.child.exitCode).toBe(null)
      expect(await owner.signal()).toBe(false)
    } finally {
      await owner.dispose()
    }
  }, 30_000)

  test(`${client.name}: a proven owner is stopped through the real client`, async () => {
    const owner = await victim("matching")
    try {
      // Awaiting `exited` lets Bun reap the child; without it the child stays a
      // zombie and still answers kill(pid, 0), which is a harness artifact.
      const [output] = await Promise.all([stop(owner.registration, client), owner.child.exited])
      expect(output).toBe("STOPPED\n")
      expect(await owner.signal()).toBe(true)
    } finally {
      await owner.dispose()
    }
  }, 30_000)

  test(`${client.name}: a caller from another installation never signals the owner`, async () => {
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
}
