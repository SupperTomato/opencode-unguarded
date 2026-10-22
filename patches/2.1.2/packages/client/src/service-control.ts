/**
 * Instance-bound lifecycle control shared by the Effect and Promise clients.
 *
 * Derivatives never stop a service by numeric PID: a PID identifies a process
 * only until it exits, and a stale registration can name one that now belongs to
 * something else. Instead the client asks the authenticated endpoint that the
 * live process itself serves, naming the exact service instance and process
 * lifetime it verified. A process that is not that instance refuses.
 *
 * This module stays free of Effect so the Promise client does not load it.
 */

import type { Info } from "./service.js"
import { fallback, headers } from "./service-probe.js"

export type ShutdownOutcome =
  /** The addressed instance accepted the request and is shutting down. */
  | { readonly status: "accepted" }
  /** The endpoint belongs to this build but does not expose instance control. */
  | { readonly status: "unsupported"; readonly reason: string }
  /** The endpoint refused because the named instance is not the one running. */
  | { readonly status: "refused"; readonly reason: string }
  /** The endpoint could not be reached or did not answer usefully. */
  | { readonly status: "unreachable"; readonly reason: string }

/**
 * Ask the verified service instance to shut itself down.
 *
 * `info` must already have been proven to belong to this caller by the caller's
 * probe; this function does not repeat ownership verification. It does repeat
 * the instance identity inside the request, so the daemon can refuse if it is
 * not the process the client believes it is talking to.
 */
export async function shutdownInstance(
  info: Info,
  timeout: number,
  installation?: string,
): Promise<ShutdownOutcome> {
  if (info.id === undefined)
    return { status: "unsupported", reason: "the registration does not name a service instance" }
  const owner = info.installation ?? installation
  if (owner === undefined) return { status: "unsupported", reason: "the registration does not name an installation" }
  const endpoint = {
    url: info.url,
    auth:
      info.password === undefined
        ? undefined
        : { type: "basic" as const, username: "opencode", password: info.password },
  }
  const response = await fetch(new URL("/api/lifecycle/shutdown", info.url), {
    method: "POST",
    headers: { ...headers(endpoint), "content-type": "application/json" },
    body: JSON.stringify({
      id: info.id,
      installation: owner,
      ...(info.startTime === undefined ? {} : { startTime: info.startTime }),
    }),
    signal: AbortSignal.timeout(timeout),
  }).catch((cause: unknown) => cause)
  if (!(response instanceof Response))
    return { status: "unreachable", reason: response instanceof Error ? response.message : "request failed" }
  if (response.status === 204) return { status: "accepted" }
  if (response.status === 404) return { status: "unsupported", reason: "the service has no instance control endpoint" }
  if (response.status === 409) return { status: "refused", reason: await reason(response) }
  if (response.status === 401 || response.status === 403) return { status: "refused", reason: "unauthorized" }
  return { status: "unreachable", reason: `unexpected HTTP ${response.status}` }
}

async function reason(response: Response) {
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string")
    return body.message
  return `HTTP ${response.status}`
}

/**
 * Whether this caller is authorized to act on a registration for lifecycle
 * purposes, independent of whether the process is still alive.
 *
 * Stale-record cleanup runs before a probe can succeed, so it must use this
 * check rather than "the PID is gone". A derivative caller may only touch a
 * record that names its own build, revision, and installation.
 */
export function authorizedRecord(
  info: Info,
  identity: { readonly name: string; readonly revision: string } | undefined,
  installation: string | undefined,
) {
  if (identity === undefined) return true
  if (info.derivative !== identity.name) return false
  if (info.derivativeRevision !== identity.revision) return false
  return installation !== undefined && info.installation === installation
}

export type StaleRecordFs = {
  readonly rename: (from: string, to: string) => Promise<void>
  readonly readFile: (file: string) => Promise<string>
  readonly unlink: (file: string) => Promise<void>
}

/**
 * Remove a stale registration only if it is still the exact record observed.
 *
 * Compare-and-unlink is not atomic, so the record is first renamed to a unique
 * quarantine name. If the renamed file is not the observed record, it is put
 * back and nothing is lost; a concurrent writer's new record is never deleted.
 */
export async function removeStaleRecord(
  file: string | undefined,
  observed: Info,
  fs: StaleRecordFs,
  same: (left: Info, right: Info) => boolean,
) {
  const target = file ?? fallback()
  const quarantine = `${target}.stale-${crypto.randomUUID()}`
  try {
    await fs.rename(target, quarantine)
  } catch {
    return false
  }
  const text = await fs.readFile(quarantine).catch(() => undefined)
  const current = text === undefined ? undefined : parse(text)
  if (current === undefined || !same(current, observed)) {
    // A different record was published between the caller's read and the
    // rename. Put it back rather than destroying a live registration.
    await fs.rename(quarantine, target).catch(() => undefined)
    return false
  }
  await fs.unlink(quarantine).catch(() => undefined)
  return true
}

function parse(text: string) {
  try {
    return JSON.parse(text) as Info
  } catch {
    return undefined
  }
}
