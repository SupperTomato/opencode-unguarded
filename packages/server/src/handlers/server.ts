import { Duration, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiSchema } from "effect/http-api"
import { HttpApiBuilder } from "effect/http-api"
import { PersistentPty } from "@opencode/core/persistent-pty"
import { ConflictError, UnauthorizedError } from "@opencode/protocol/errors"
import { Api } from "../api"
import { ServerAuth } from "../auth"
import { ServerInfo } from "../server-info"
import { ServerIdentity } from "../identity"
import { ServerControl } from "../control"
import { ServerPairing } from "../pairing"

export const ServerHandler = HttpApiBuilder.group(Api, "server.server", (handlers) =>
  Effect.gen(function* () {
    const pairing = yield* ServerPairing.Service
    const auth = yield* ServerAuth.Config

    return handlers
      .handle("server.info", () =>
        Effect.gen(function* () {
          const info = yield* ServerInfo.Service
          return {
            version: info.app.version ?? "unknown",
            pid: process.pid ?? 0,
            ...ServerIdentity.identity(info.app),
            urls: info.urls(),
            paths: info.paths,
            capabilities: { persistentPty: PersistentPty.available },
          }
        }),
      )
      .handle("server.pair", () => pairing.issue())
      .handle(
        "server.shutdown",
        Effect.fn(function* (ctx) {
          const info = yield* ServerInfo.Service
          const control = yield* ServerControl.Service
          // Only a managed daemon exposes this control surface. A request that
          // names a different instance or process lifetime is refused: the
          // caller's registration may be stale, and this process must not be
          // stopped on behalf of a different owner.
          if (!control.available)
            return yield* new ConflictError({ message: "this server is not a managed service", resource: "lifecycle" })
          if (control.instanceId !== ctx.payload.id || info.app.installation !== ctx.payload.installation)
            return yield* new ConflictError({
              message: "the requested service instance is not running here",
              resource: "lifecycle",
            })
          if (control.startTime !== ctx.payload.startTime)
            return yield* new ConflictError({
              message: "the requested process lifetime is not running here",
              resource: "lifecycle",
            })
          // Let the response flush before the process starts shutting down.
          yield* Effect.forkDetach(Effect.sleep("10 millis").pipe(Effect.andThen(control.shutdown)))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "server.connect",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          // Browser navigations ask for HTML; everything else is an API client that wants the token.
          const browser = request.headers.accept?.includes("text/html") === true
          const token = (yield* pairing.consume(ctx.params.code)) ? ServerAuth.issueSession(auth) : undefined
          if (token === undefined) {
            if (!browser) return yield* new UnauthorizedError({ message: "Pairing link expired or already used" })
            return HttpServerResponse.text(
              "This pairing link expired or was already used. Run `opencode pair` to get a new one.",
              { status: 401 },
            )
          }
          if (!browser) return { token }
          return HttpServerResponse.redirect("/").pipe(
            HttpServerResponse.setCookieUnsafe(ServerAuth.sessionCookieName(request.headers.host), token, {
              path: "/",
              httpOnly: true,
              sameSite: "lax",
              maxAge: Duration.seconds(ServerAuth.SESSION_TTL_SECONDS),
            }),
          )
        }),
      )
  }),
)
