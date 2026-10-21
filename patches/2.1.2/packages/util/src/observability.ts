export * as Observability from "./observability.js"

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { LayerNode } from "./effect/layer-node.js"
import { Layer, Logger, References, Schema } from "effect"
import { Logging } from "./observability/logging.js"

export const Options = Schema.Struct({
  endpoint: Schema.optional(Schema.String),
  headers: Schema.optional(Schema.String),
  client: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export function layer(
  options: Options = {
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
  },
) {
  const app = {
    client: options.client ?? "opencode",
    version: options.version ?? "unknown",
    channel: options.channel ?? "local",
  }
  // opencode-unguarded: `--dry-run` promises the filesystem is unchanged, so it
  // uses only the stderr logger: opening the shared log file would create the
  // log directory and append to a file.
  const loggers = process.argv.includes("--dry-run")
    ? [Logging.stderrLogger]
    : Logging.loggers(app.channel === "local", app.channel)
  const local = Logger.layer(loggers, { mergeWithExisting: false }).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.orDie,
    Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
  )
  // opencode-unguarded: telemetry disabled at build time. Only local logging is
  // installed; no OTLP logger, exporter, or tracing layer is constructed.
  return local
}

// Layer.suspend: constructing the loggers eagerly at module scope performs
// I/O (file logger, run id) that workerd forbids in global scope.
export const node = LayerNode.make({
  name: "observability",
  layer: Layer.suspend(() => layer()),
  deps: [],
})
