import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Otlp } from "../src/observability/otlp.js"

// opencode-unguarded: this derivative must never create OTLP exporters.
test("tracingLayer never exports spans even when an endpoint is configured", async () => {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      return Response.json({})
    },
  })

  try {
    await Effect.gen(function* () {
      const tracing = yield* Otlp.tracingLayer(
        { endpoint: server.url.origin, headers: "x-otel-test=present" },
        { client: "test", version: "1.0.0", channel: "local" },
      )
      yield* Effect.void.pipe(Effect.withSpan("otlp-smoke"), Effect.provide(tracing))
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(requests).toHaveLength(0)
  } finally {
    server.stop(true)
  }
})

test("loggers never create an OTLP logger even when an endpoint is configured", () => {
  expect(Otlp.loggers({ endpoint: "http://127.0.0.1:1" }, { client: "test", version: "1.0.0", channel: "local" })).toEqual(
    [],
  )
})
