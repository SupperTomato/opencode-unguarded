import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, UnauthorizedError } from "../errors.js"

export const ServerInfo = Schema.Struct({
  version: Schema.String,
  // 0 means the runtime has no OS process identity (e.g. workerd).
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  // opencode-unguarded: build and installation identity. Optional so clients
  // still decode stock servers and older derivative revisions, which cannot
  // prove derivative ownership.
  derivative: Schema.optional(Schema.String),
  derivativeRevision: Schema.optional(Schema.String),
  installation: Schema.optional(Schema.String),
  // Operating-system process start time, used to detect a reused PID.
  startTime: Schema.optional(Schema.String),
  urls: Schema.Array(Schema.String),
  paths: Schema.Struct({
    tmp: Schema.String,
  }),
  // Optional at every level so clients still decode servers that predate a capability.
  capabilities: Schema.optional(
    Schema.Struct({
      persistentPty: Schema.optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "ServerInfo" })
export type ServerInfo = typeof ServerInfo.Type

// opencode-unguarded: authenticated lifecycle control for the managed daemon.
// The request names the exact service instance and process lifetime the caller
// observed, so a stale registration or reused PID cannot stop a different
// process. Stock servers do not expose this endpoint.
export const ShutdownInput = Schema.Struct({
  id: Schema.String,
  installation: Schema.String,
  startTime: Schema.optional(Schema.String),
}).annotate({ identifier: "ShutdownInput" })
export type ShutdownInput = typeof ShutdownInput.Type

export const PairingCode = Schema.Struct({
  code: Schema.String,
  expires_in: Schema.Int,
}).annotate({ identifier: "PairingCode" })
export type PairingCode = typeof PairingCode.Type

export const PairingSession = Schema.Struct({
  token: Schema.String,
}).annotate({ identifier: "PairingSession" })
export type PairingSession = typeof PairingSession.Type

export const PAIRING_CONNECT_PATH = "/auth/connect/:code"

const PAIRING_CONNECT_URL = /^\/auth\/connect\/[^/]+$/

export function isPairingConnectURL(url: URL) {
  return PAIRING_CONNECT_URL.test(url.pathname)
}

export const ServerGroup = HttpApiGroup.make("server.server")
  .add(
    HttpApiEndpoint.get("server.info", "/api/info", {
      success: ServerInfo,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.info",
        summary: "Get server info",
        description: "Return the server identity, connection URLs, paths, and readiness status.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("server.pair", "/api/pair", {
      success: PairingCode,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.pair",
        summary: "Create pairing code",
        description: "Create a short-lived, single-use code for a /auth/connect/:code pairing link.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("server.shutdown", "/api/lifecycle/shutdown", {
      payload: ShutdownInput,
      success: HttpApiSchema.NoContent,
      error: [ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.shutdown",
        summary: "Stop this service instance",
        description:
          "Ask the managed daemon to shut down. The request must name this exact instance and process lifetime; a mismatch is refused so a stale client cannot stop a replacement process.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("server.connect", PAIRING_CONNECT_PATH, {
      params: { code: Schema.String },
      success: PairingSession,
      error: UnauthorizedError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.connect",
        summary: "Redeem pairing code",
        description:
          "Redeem a pairing code. Browsers receive a session cookie and a redirect to the web app; requests that accept JSON receive a session token to use as the password.",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "server" }))
