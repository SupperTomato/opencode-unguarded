import { Option, Schema } from "effect"

declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_RELEASE_HIGHLIGHTS: string
declare const OPENCODE_UNGUARDED: boolean
declare const OPENCODE_UNGUARDED_REVISION: string
declare const OPENCODE_UNGUARDED_UPSTREAM: string

const version = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
const channel = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OPENCODE_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OPENCODE_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

// opencode-unguarded: derivative identity. Compiled in, never read from the
// environment, so lifecycle decisions cannot be reconfigured at runtime.
export const UNGUARDED = typeof OPENCODE_UNGUARDED === "boolean" && OPENCODE_UNGUARDED

export const UNGUARDED_IDENTITY = {
  name: "opencode-unguarded",
  revision: typeof OPENCODE_UNGUARDED_REVISION === "string" ? OPENCODE_UNGUARDED_REVISION : "source",
  upstream: typeof OPENCODE_UNGUARDED_UPSTREAM === "string" ? OPENCODE_UNGUARDED_UPSTREAM : "unknown",
} as const

export {
  version as OPENCODE_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  highlights as OPENCODE_HIGHLIGHTS,
}
export const OPENCODE_LOCAL = channel === "local"
