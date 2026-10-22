import { readFile, rename, rm, unlink } from "node:fs/promises"
import type { DiscoverOptions, Endpoint, Info, EnsureOptions, StopOptions } from "../service.js"
import { contenderPool, spawnServiceContender } from "../service-contender.js"
import { defaultEnsureTiming, ensureTiming, type EnsureTiming } from "../service-timing.js"
import { matchesVersion } from "../service-version.js"
import { PtyHandoff } from "../pty-handoff.js"
import {
  buildIdentity,
  decide,
  fallback,
  headers,
  isDerivative,
  isOwnershipConflict,
  ownedByThisBuild,
  ownerExited,
  probeResult,
  same,
  type LocalService,
} from "../service-probe.js"
import { authorizedRecord, removeStaleRecord, shutdownInstance } from "../service-control.js"
import { parseRegistration } from "../service-registration-decoder.js"

export * from "../service.js"
export { headers }

// Find, start, and stop the local opencode background service.
//
// The registration file is the complete discovery contract. This module is
// intentionally implemented with Node APIs so Promise clients do not need
// Effect or @effect/platform-node at runtime.

/** Discover a healthy, compatible local service without starting one. */
export async function discover(options: DiscoverOptions = {}) {
  const found = (await registered(options.file, undefined, options.installation)).service
  if (found?.state !== "ready") return undefined
  if (!ownedByThisBuild(found.info)) return undefined
  if (!found.compatible) return undefined
  if (!matchesVersion(found.version, options)) return undefined
  return found.endpoint
}

/** Ensure a healthy, compatible local service is running. */
export async function ensure(options: EnsureOptions = {}): Promise<Endpoint> {
  const timing = ensureTiming(options)
  const deadline = Date.now() + timing.promiseTimeout
  const pool = contenderPool(timing)
  let timeouts: { readonly info: Info; readonly count: number } | undefined
  let announced = false

  const announce = (reason: "missing" | "version-mismatch", previousVersion?: string) => {
    if (announced) return
    announced = true
    options.onStart?.(reason, previousVersion)
  }
  const spawnContender = async () => {
    const [command, ...args] = options.command ?? ["opencode", "serve", "--service"]
    if (command === undefined) throw new Error("Missing service command")
    try {
      return spawnServiceContender(command, args, await PtyHandoff.environment(options.file ?? fallback(), options.env))
    } catch (cause) {
      throw new Error("Failed to start server", { cause })
    }
  }

  try {
    while (true) {
      if (Date.now() >= deadline)
        throw pool.failure() ?? new Error("Timed out waiting for the background service to start")
      const registration = await registered(options.file, timing.requestTimeout, options.installation)
      if (registration.timedOut && registration.info !== undefined) {
        timeouts = {
          info: registration.info,
          count: timeouts !== undefined && same(timeouts.info, registration.info) ? timeouts.count + 1 : 1,
        }
        if (timeouts.count >= 3) {
          announce("missing")
          console.warn("Background service is unresponsive; recovery cannot preserve persistent terminals")
          await PtyHandoff.clear(options.file ?? fallback())
          await terminate(registration.info, options, timing)
          pool.evict(registration.info.pid)
          pool.recruitNow()
          timeouts = undefined
        }
      } else timeouts = undefined

      if (registration.service !== undefined) {
        pool.serviceAnswered()
        const service = registration.service
        const decision = decide(service, options)
        if (decision._tag === "fail") throw decision.error
        if (decision._tag === "reuse") {
          await PtyHandoff.complete(options.file ?? fallback(), service.info)
          return service.endpoint
        }
        if (decision._tag === "replace") {
          announce("version-mismatch", service.version)
          if (service.state !== "ready")
            console.warn("Background service is not ready; replacement cannot preserve persistent terminals")
          await stop({ file: options.file, pty: decision.pty, installation: options.installation }).catch(
          () => undefined,
        )
          pool.evict(service.info.pid)
        }
      } else {
        // A registration naming another build or installation is not a missing
        // service: spawning a contender would either fail on the port or make
        // the mismatch harder to see. Report it instead.
        if (registration.info !== undefined && isOwnershipConflict(registration)) throw ownershipError(registration)
        const failed = pool.reap()
        if (failed !== undefined) throw failed
        if (pool.shouldRecruit(registration.info !== undefined)) {
          announce("missing")
          pool.add(await spawnContender())
        }
      }
      await delay(timing.pollInterval)
    }
  } finally {
    pool.releaseAll()
  }
}

/** Stop the registered local service. */
export async function stop(options: StopOptions = {}) {
  const info = await read(options.file)
  // Terminal handoff is best-effort; it must never keep the old service running.
  // A derivative build also refuses to prepare handoff state for an owner it
  // cannot verify, so an unrelated process is never touched.
  // Ownership is proven before any terminal side effect, and before any signal.
  const verified = isDerivative() && info !== undefined
    ? await requireVerifiedOwner(info, options, defaultEnsureTiming.requestTimeout)
    : undefined
  if (verified === "exited") {
    if (info !== undefined) await terminate(info, options, ensureTiming(options))
    return
  }
  await (
    options.pty === "handoff" && info !== undefined
      ? PtyHandoff.prepare(options.file ?? fallback(), info, defaultEnsureTiming.requestTimeout)
      : PtyHandoff.clear(options.file ?? fallback())
  ).catch((cause: unknown) => console.warn("Failed to prepare persistent terminals for replacement", cause))
  if (info !== undefined) await terminate(info, options, ensureTiming(options), verified)
}

async function requireVerifiedOwner(info: Info, options: StopOptions, timeout: number) {
  // A stale record is the caller's own business only. Authorize first: a
  // foreign installation's exited owner must not be cleaned up here.
  if (ownerExited(info)) {
    if (!authorizedRecord(info, buildIdentity(), options.installation))
      throw new Error(
        `refusing to stop service pid ${info.pid}: the registration belongs to a different build or installation, ` +
          `and its process is not running. Check ${options.file ?? fallback()}.`,
      )
    return "exited" as const
  }
  const probe = await probeResult(info, timeout, options)
  if (probe.status !== "verified" || probe.service === undefined)
    throw new Error(
      `refusing to stop service pid ${info.pid}: the registered endpoint did not prove it is this owner` +
        `${probe.reason === undefined ? "" : ` (${probe.reason})`}. ` +
        `Check ${options.file ?? fallback()} and stop the process manually if it is still running.`,
    )
  return probe.service
}

function ownershipError(outcome: { readonly reason?: string }) {
  return new Error(
    `The registered background service belongs to a different OpenCode build or installation` +
      `${outcome.reason === undefined ? "" : ` (${outcome.reason})`}. Stop it, then start this build.`,
  )
}

async function read(file?: string): Promise<Info | undefined> {
  const text = await readFile(file ?? fallback(), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const decoded = parseRegistration(text)
  return decoded._tag === "valid" ? decoded.info : undefined
}

async function registered(file?: string, timeout?: number, installation?: string) {
  const info = await read(file)
  if (info === undefined) return { info: undefined, service: undefined, timedOut: false }
  return { info, ...(await probeResult(info, timeout, { installation })) }
}

/**
 * Whether the registered process is gone.
 *
 * A PID that no longer exists is gone. A PID that is alive but whose start time
 * differs belongs to a different process, which is also "the owner is gone" —
 * but only ownerExited() may draw that conclusion, because it needs the recorded
 * lifetime. Returning true here means only "nothing is running at this PID now".
 */
function stopped(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function waitUntilStopped(pid: number, timing: EnsureTiming) {
  for (let attempt = 0; attempt <= timing.stopPollAttempts; attempt++) {
    if (stopped(pid)) return true
    if (attempt < timing.stopPollAttempts) await delay(timing.stopPollInterval)
  }
  return false
}

async function terminate(
  info: Info,
  options: StopOptions,
  timing: EnsureTiming,
  alreadyVerified?: LocalService,
) {
  const current = await read(options.file)
  if (current === undefined || !same(current, info)) return
  // opencode-unguarded never signals a PID that is not proven to be this
  // registered owner. Stock builds keep upstream recovery, which deliberately
  // replaces an unresponsive owner that cannot answer.
  if (isDerivative()) {
    // Only a caller that is authorized for this record may clear a stale one.
    // "The PID is gone" is not authority: a foreign installation's dead record
    // is still that installation's business.
    if (ownerExited(info)) {
      if (!authorizedRecord(info, buildIdentity(), options.installation)) return
      await removeStaleRecord(
        options.file,
        info,
        { rename, readFile: (file) => readFile(file, "utf8"), unlink },
        same,
      )
      return
    }
    // Never signal by numeric PID. Ask the authenticated endpoint to stop the
    // exact instance the caller verified; it refuses if it is not that process.
    const owner = alreadyVerified ?? (await probeResult(info, timing.requestTimeout, options)).service
    if (owner === undefined)
      throw new Error(
        `refusing to stop service pid ${info.pid}: the registered endpoint did not prove it is this owner. ` +
          `Check ${options.file ?? fallback()} and stop the process manually if it is still running.`,
      )
    const outcome = await shutdownInstance(info, timing.requestTimeout, options.installation)
    if (outcome.status === "refused")
      throw new Error(`refusing to stop service pid ${info.pid}: the running instance refused the request (${outcome.reason})`)
    if (outcome.status === "unreachable")
      throw new Error(
        `refusing to stop service pid ${info.pid}: the instance could not be asked to stop (${outcome.reason}). ` +
          `Check ${options.file ?? fallback()} and stop the process manually if it is still running.`,
      )
    if (outcome.status === "unsupported")
      throw new Error(
        `refusing to stop service pid ${info.pid}: this build cannot prove instance identity (${outcome.reason}). ` +
          `Stop the process manually if it is still running.`,
      )
    if (!(await waitUntilStopped(info.pid, timing)))
      throw new Error(
        `service process ${info.pid} accepted the shutdown request but is still running; ` +
          `it was not signalled, so stop it manually if it remains`,
      )
    const latest = await read(options.file)
    if (latest === undefined || !same(latest, info)) return
    await removeStaleRecord(
        options.file,
        info,
        { rename, readFile: (file) => readFile(file, "utf8"), unlink },
        same,
      )
    return
  }
  // Stock builds keep upstream recovery: an unresponsive owner is replaced.
  signalStock(info.pid, "SIGTERM")
  // The registration can disappear or change hands before this process exits. Only the PID we
  // signalled can tell us whether it has stopped, so escalate based on that process.
  if (!(await waitUntilStopped(info.pid, timing))) {
    signalStock(info.pid, "SIGKILL")
    if (!(await waitUntilStopped(info.pid, timing))) throw new Error(`Server process ${info.pid} is still running`)
  }
  const latest = await read(options.file)
  if (latest === undefined || !same(latest, info)) return
  await rm(options.file ?? fallback(), { force: true })
}

function signalStock(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

/** Promise-based local service lifecycle operations. */
export const Service = { discover, ensure, stop, headers }
