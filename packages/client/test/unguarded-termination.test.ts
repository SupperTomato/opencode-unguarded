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
const serviceModule = path.join(import.meta.dir, "..", "src", "promise", "service.ts")

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

async function stop(registration: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      ...DEFINES,
      "-e",
      `
const { stop } = await import(${JSON.stringify(serviceModule)})
try {
  await stop({ file: ${JSON.stringify(registration)} })
  console.log("STOPPED")
} catch (error) {
  console.log("REFUSED " + error.message)
}
`,
    ],
    { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  expect(code).toBe(0)
  return stdout
}

test("a 404 health response never authorizes signalling the registered PID", async () => {
  const owner = await victim("not-found")
  try {
    const output = await stop(owner.registration)
    expect(output).toContain("REFUSED")
    expect(output).toContain("not-found")
    // The unrelated process is still alive and received no signal.
    expect(owner.child.exitCode).toBe(null)
    expect(await owner.signal()).toBe(false)
  } finally {
    await owner.dispose()
  }
}, 30_000)

test("a proven owner is stopped through the real client", async () => {
  const owner = await victim("matching")
  try {
    // Awaiting `exited` lets Bun reap the child; without it the child stays a
    // zombie and still answers kill(pid, 0), which is a harness artifact.
    const [output] = await Promise.all([stop(owner.registration), owner.child.exited])
    expect(output).toBe("STOPPED\n")
    expect(await owner.signal()).toBe(true)
  } finally {
    await owner.dispose()
  }
}, 30_000)
