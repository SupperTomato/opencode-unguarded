import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, Info } from "./service.js"
import { defaultEnsureTiming } from "./service-timing.js"
import { matchesVersion } from "./service-version.js"

// opencode-unguarded: compiled in by the derivative build. When set, a service
// registration and its live owner must both carry the derivative marker, the
// same derivative revision, and the same installation identity.
declare const OPENCODE_UNGUARDED: boolean | undefined
declare const OPENCODE_UNGUARDED_REVISION: string | undefined
declare const OPENCODE_UNGUARDED_UPSTREAM: string | undefined
const DERIVATIVE = typeof OPENCODE_UNGUARDED === "boolean" && OPENCODE_UNGUARDED
const DERIVATIVE_MARKER = "opencode-unguarded"

/** Whether this executable is the opencode-unguarded build. */
export function isDerivative() {
  return DERIVATIVE
}

/** The derivative identity this executable was compiled with. */
export type BuildIdentity = {
  readonly name: string
  readonly revision: string
  readonly upstream: string
}

/**
 * Identity of the build performing discovery, or undefined for stock builds.
 * Revision and upstream are compiled constants; no environment variable can
 * make a stock build look like a derivative one, or relabel a revision.
 */
export function buildIdentity(): BuildIdentity | undefined {
  if (!DERIVATIVE) return undefined
  return {
    name: DERIVATIVE_MARKER,
    revision: typeof OPENCODE_UNGUARDED_REVISION === "string" ? OPENCODE_UNGUARDED_REVISION : "source",
    upstream: typeof OPENCODE_UNGUARDED_UPSTREAM === "string" ? OPENCODE_UNGUARDED_UPSTREAM : "unknown",
  }
}

/**
 * Whether a registration was written by this exact build.
 *
 * Version equality alone is not ownership: stock 2.1.2 has the same version
 * string. A different derivative revision is a different build and must not be
 * silently reused, because lifecycle and storage behavior changed between them.
 */
export function ownedByThisBuild(info: {
  readonly derivative?: string
  readonly derivativeRevision?: string
}) {
  const identity = buildIdentity()
  if (identity === undefined) return true
  if (info.derivative !== identity.name) return false
  // A registration without a revision predates revisioned registrations and
  // cannot prove which build wrote it, so it is not ours.
  if (info.derivativeRevision === undefined) return false
  return info.derivativeRevision === identity.revision
}

// Shared by the Effect and Promise clients. Keep this module free of Effect so the
// Promise client never loads the Effect runtime.

export type LocalService = {
  readonly info: Info
  readonly endpoint: Endpoint
  readonly version?: string
  readonly state: "ready" | "waiting" | "failed"
  readonly compatible: boolean
  /** OS process start time reported by the live owner, when it provides one. */
  readonly startTime?: string
}

/**
 * What `ensure()` does with a registered service that answered: return it, keep polling while
 * it starts, replace it because its version does not meet the requirement, or fail.
 */
export function decide(service: LocalService, options: DiscoverOptions) {
  // A foreign build never satisfies discovery, even at the same version.
  if (!ownedByThisBuild(service.info))
    return fail(
      "The registered background service belongs to a different OpenCode build (distribution or derivative revision). " +
        "Stop it, then start this build.",
    )
  // An endpoint that cannot prove which build and installation it serves must
  // never be replaced automatically: replacing means stopping what the
  // registration names, and that may not be the process answering.
  if (DERIVATIVE && !service.compatible)
    return fail(
      "The registered background service could not prove its health identity. " +
        "Stop it explicitly, then start this build.",
    )
  if (!matchesVersion(service.version, options))
    return { _tag: "replace", pty: service.state === "ready" ? "handoff" : "clear" } as const
  if (!service.compatible)
    return fail(
      "Background service uses an incompatible health protocol. Update this client or explicitly restart the service.",
    )
  if (service.state === "ready") return { _tag: "reuse" } as const
  if (service.state === "failed") return fail("Background service failed to start")
  return { _tag: "wait" } as const
}

function fail(message: string) {
  return { _tag: "fail" as const, error: new Error(message) }
}

/** The default registration file. */
export function fallback() {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

/** Whether two registrations describe the same service instance. */
export function same(left: Info, right: Info) {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.derivative === right.derivative &&
    left.derivativeRevision === right.derivativeRevision &&
    left.installation === right.installation &&
    left.startTime === right.startTime &&
    left.url === right.url &&
    left.pid === right.pid
  )
}

/**
 * Result of asking a registered owner to prove its identity.
 *
 * `service` is only set for an owner whose health response matched the
 * registration. `status` separates "answered and matched" from "answered but
 * proved nothing" and "answered with an older protocol", so callers cannot
 * mistake a response for ownership.
 */
export type ProbeOutcome = {
  /** The verified owner, when `status` is "verified". */
  readonly service?: LocalService
  /** Outcome for callers that need to report why an owner was not used. */
  readonly status: "verified" | "unverified" | "incompatible" | "absent"
  readonly reason?: ProbeFailure
  readonly timedOut: boolean
}

/**
 * Whether a probe outcome is a definitive ownership verdict rather than a
 * transient or unprovable state. Callers must not spawn a replacement when the
 * registration names an owner this build refuses to adopt.
 */
export function isOwnershipConflict(outcome: ProbeOutcome) {
  // Stock builds keep upstream recovery behavior: a transient PID mismatch
  // while an owner self-evicts is retried, not surfaced as a fatal conflict.
  if (!DERIVATIVE) return false
  if (outcome.status === "verified") return false
  return (
    outcome.reason === "build-mismatch" ||
    outcome.reason === "installation-mismatch" ||
    outcome.reason === "pid-mismatch"
  )
}

export type ProbeFailure =
  | "unreachable"
  | "timeout"
  | "unauthorized"
  | "not-found"
  | "malformed"
  | "pid-mismatch"
  | "version-mismatch"
  | "build-mismatch"
  | "installation-mismatch"
  | "lifecycle-mismatch"

/** Ask a registered owner for its health and prove its identity. */
export async function probeResult(info: Info, timeout = defaultEnsureTiming.requestTimeout): Promise<ProbeOutcome> {
  const endpoint = {
    url: info.url,
    auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password },
  } satisfies Endpoint
  const signal = AbortSignal.timeout(timeout)
  const result = await fetch(new URL("/api/info", info.url), { headers: headers(endpoint), signal })
    .then(async (response) => ({
      response,
      body: response.status === 404 ? undefined : await response.json().catch(() => undefined),
    }))
    .catch(() => undefined)
  if (result === undefined)
    return { status: "unverified", reason: signal.aborted ? "timeout" : "unreachable", timedOut: signal.aborted }
  const response = result.response
  if (response.status === 404) {
    // A missing health endpoint identifies protocol incompatibility, not an
    // older version. It also proves nothing about which process is answering,
    // so a derivative build never treats it as an owner it may signal.
    if (DERIVATIVE) return { status: "incompatible", reason: "not-found", timedOut: false }
    return {
      status: "verified",
      timedOut: false,
      service: {
        info,
        endpoint,
        version: info.version,
        state: "ready",
        compatible: false,
      } satisfies LocalService,
    }
  }
  if (response.status === 401 || response.status === 403)
    return { status: "unverified", reason: "unauthorized", timedOut: false }
  const serverInfo = decodeInfo(result.body)
  if (serverInfo === undefined) return { status: "unverified", reason: "malformed", timedOut: false }
  // The PID in the health response is the process answering the request, so a
  // match proves the endpoint belongs to the registered PID.
  if (serverInfo.pid !== info.pid) return { status: "unverified", reason: "pid-mismatch", timedOut: false }
  if (info.version !== undefined && serverInfo.version !== info.version)
    return { status: "incompatible", reason: "version-mismatch", timedOut: false }
  const mismatch = identityMismatch(info, serverInfo)
  if (mismatch !== undefined) return { status: "unverified", reason: mismatch, timedOut: false }
  return {
    status: "verified",
    timedOut: false,
    service: {
      info,
      endpoint,
      version: serverInfo.version,
      state: response.ok ? "ready" : response.status === 500 ? "failed" : "waiting",
      compatible: true,
      startTime: serverInfo.startTime,
    } satisfies LocalService,
  }
}

/**
 * Whether the registered process is provably gone.
 *
 * A dead owner leaves a stale registration behind. Removing that registration is
 * safe; signalling anything is not, because the PID may already belong to an
 * unrelated process. When the platform exposes a start time, it is compared
 * with the live one so a reused PID is classified as gone rather than alive.
 */
export function ownerExited(info: { readonly pid: number; readonly startTime?: string }) {
  if (!processAlive(info.pid)) return true
  if (info.startTime === undefined) return false
  const current = processStartTime(info.pid)
  return current === undefined || current !== info.startTime
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

function processStartTime(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined
  try {
    // Field 22 (start time) is index 19 after the `comm` field, which can
    // contain spaces, so parsing starts after the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    return fields[19] === undefined ? undefined : `linux:${fields[19]}`
  } catch {
    return undefined
  }
}

/** Create HTTP authentication headers for a service endpoint. */
export function headers(endpoint: Endpoint) {
  if (endpoint.auth === undefined) return undefined
  return {
    authorization: "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64"),
  }
}

/**
 * The registration and the live endpoint must describe the same build and the
 * same installation. A derivative build requires both sides to carry the
 * revision it was compiled with; a stock build has no such expectations.
 */
function identityMismatch(
  registration: Info,
  live: { derivative?: string; derivativeRevision?: string; installation?: string },
): ProbeFailure | undefined {
  const identity = buildIdentity()
  if (identity === undefined) return undefined
  if (registration.derivative !== identity.name || registration.derivativeRevision !== identity.revision)
    return "build-mismatch"
  if (live.derivative !== identity.name) return "build-mismatch"
  if (live.derivativeRevision !== identity.revision) return "build-mismatch"
  if (registration.installation === undefined || registration.installation !== live.installation)
    return "installation-mismatch"
  return undefined
}

function decodeInfo(input: unknown) {
  if (typeof input !== "object" || input === null) return
  if (!("version" in input) || typeof input.version !== "string") return
  if (!("pid" in input) || typeof input.pid !== "number" || !Number.isInteger(input.pid) || input.pid < 0) return
  return {
    version: input.version,
    pid: input.pid,
    startTime: optionalString(input, "startTime"),
    derivative: optionalString(input, "derivative"),
    derivativeRevision: optionalString(input, "derivativeRevision"),
    installation: optionalString(input, "installation"),
  }
}

function optionalString(input: object, key: string) {
  if (!(key in input)) return undefined
  const value = (input as Record<string, unknown>)[key]
  return typeof value === "string" ? value : undefined
}
