export * as ServiceRegistration from "./service-registration"

import { Service, type Info } from "@opencode/client/effect/service"
import path from "node:path"
import { Effect, FileSystem, Option, Schedule, Schema } from "effect"
import { HttpServer } from "effect/http"
import { NetAddress } from "effect/net"
import { OPENCODE_VERSION, UNGUARDED, UNGUARDED_IDENTITY } from "../version"
import { installationIdentity } from "./installation"

const infoJson = Schema.fromJsonString(Service.Info)
const encodeInfo = Schema.encodeEffect(infoJson)
const decodeInfo = Schema.decodeUnknownEffect(infoJson)

export const register = Effect.fnUntraced(function* (options: {
  readonly address: NetAddress.SocketAddress
  readonly password: string
  readonly id: string
  readonly file: string
  readonly shutdown: Effect.Effect<void>
  /** opencode-unguarded: build and installation the managed service belongs to. */
  readonly derivative?: string
  readonly derivativeRevision?: string
  readonly installation?: string
  /** Operating-system process start time, used to recognize a reused PID. */
  readonly startTime?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const temp = options.file + "." + options.id + ".tmp"
  yield* fs.makeDirectory(path.dirname(options.file), { recursive: true })
  const info = {
    id: options.id,
    version: OPENCODE_VERSION,
    // opencode-unguarded: ownership identity. Stock OpenCode omits these fields,
    // so an equal version number can never make a stock registration look ours,
    // and another derivative revision or installation is a different owner.
    ...(UNGUARDED && options.derivative !== undefined
      ? {
          derivative: options.derivative,
          derivativeRevision: options.derivativeRevision,
          installation: options.installation,
        }
      : {}),
    ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
    url: HttpServer.formatAddress(options.address),
    pid: process.pid,
    password: options.password,
  }
  const encoded = yield* encodeInfo(info)
  const current = fs.readFileString(options.file).pipe(Effect.flatMap(decodeInfo))
  const owns = (found: Info) =>
    found.id === info.id &&
    found.version === info.version &&
    found.derivative === info.derivative &&
    found.derivativeRevision === info.derivativeRevision &&
    found.installation === info.installation &&
    found.url === info.url &&
    found.pid === info.pid &&
    found.password === info.password

  // opencode-unguarded: publishing a registration displaces whoever is named
  // there. Before overwriting, prove the existing record is ours to replace: a
  // live foreign owner must not be evicted by a second installation that
  // happens to share the profile. A stale record may be reclaimed only when it
  // names this installation (or is unreadable debris from no live owner).
  const displacement = yield* displacesOwner(fs, options.file, info)
  if (displacement !== undefined)
    return yield* Effect.fail(new Error(displacement))

  yield* fs.writeFileString(temp, encoded, { mode: 0o600 }).pipe(Effect.andThen(fs.rename(temp, options.file)))
  yield* current.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("managed service registration check failed; shutting down", {
        cause,
        serviceID: options.id,
        servicePID: process.pid,
        registration: options.file,
      }).pipe(Effect.andThen(Effect.failCause(cause))),
    ),
    Effect.tap((found) =>
      owns(found)
        ? Effect.void
        : Effect.logWarning("managed service registration replaced; shutting down", {
            serviceID: options.id,
            servicePID: process.pid,
            registration: options.file,
            observedServiceID: found.id,
            observedServicePID: found.pid,
            observedVersion: found.version,
            observedURL: found.url,
          }),
    ),
    Effect.filterOrFail(owns),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.ignore,
    Effect.andThen(options.shutdown),
    Effect.forkScoped,
  )
  return current.pipe(
    Effect.flatMap((found) => (owns(found) ? fs.remove(options.file) : Effect.void)),
    Effect.ignore,
  )
})

/**
 * Why publishing this registration would displace another live owner, if it
 * would.
 *
 * Reading the record and then renaming over it is not atomic, but the check is
 * enough to stop the ordinary case: a second installation starting against a
 * shared profile sees a live record that is not its own and refuses, instead of
 * overwriting it and relying on the incumbent's monitor to shut itself down.
 * Only the derivative enforces this; stock keeps upstream replacement behavior.
 */
const displacesOwner = (fs: FileSystem.FileSystem, file: string, info: Record<string, unknown>) =>
  Effect.gen(function* () {
    if (!UNGUARDED) return undefined
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    if (text._tag === "None") return undefined
    const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Service.Info))(text.value).pipe(
      Effect.option,
    )
    if (Option.isNone(decoded)) return undefined
    const found = decoded.value
    if (found.pid === process.pid) return undefined
    const ours =
      found.derivative === UNGUARDED_IDENTITY.name &&
      found.derivativeRevision === UNGUARDED_IDENTITY.revision &&
      found.installation === installationIdentity().id
    if (ours) return undefined
    // A record from this installation that is no longer running is stale and
    // may be replaced. Anything else is someone else's live service.
    const alive = yield* Effect.sync(() => {
      try {
        process.kill(found.pid, 0)
        return true
      } catch {
        return false
      }
    })
    if (!alive) return undefined
    return (
      `refusing to replace the service registration at ${file}: it belongs to ` +
      `${found.installation === undefined ? "another OpenCode instance" : "a different installation"} ` +
      `(pid ${found.pid}). Stop that service, or use a separate profile.`
    )
  })
