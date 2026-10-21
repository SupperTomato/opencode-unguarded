import { Effect, Layer } from "effect"
import { runID } from "./shared.js"

export interface Options {
  readonly endpoint?: string
  readonly headers?: string
}

export interface App {
  readonly client: string
  readonly version: string
  readonly channel: string
}

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(app: App = { client: "opencode", version: "unknown", channel: "local" }): {
  serviceName: string
  serviceVersion: string
  attributes: Record<string, string>
} {
  return {
    serviceName: "opencode",
    serviceVersion: app.version,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": app.channel,
      "opencode.client": app.client,
      "opencode.run": runID(),
      "service.instance.id": runID(),
    },
  }
}

// opencode-unguarded: telemetry disabled at build time. Resource construction
// remains for API compatibility, but no exporter can be created.
export function loggers(_options: Options | undefined, _app: App) {
  return []
}

export const tracingLayer = Effect.fnUntraced(function* (_options: Options | undefined, _app: App) {
  return Layer.empty
})

export * as Otlp from "./otlp.js"
