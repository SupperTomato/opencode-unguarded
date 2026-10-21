import path from "node:path"
import { OPENCODE_CHANNEL, UNGUARDED } from "./version"

const DERIVATIVE_DB = "opencode-unguarded.db"

export function databasePath(data: string) {
  // opencode-unguarded: keep the derivative database separate from stock
  // installs while still honoring an explicit override. The launcher already
  // constrains overrides to a plain filename inside the profile; repeating the
  // check here keeps a direct invocation from escaping through OPENCODE_DB.
  if (UNGUARDED) return derivativeDatabase(data)
  const filename =
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}

function derivativeDatabase(data: string) {
  const override = process.env.OPENCODE_DB
  if (override === undefined || override.length === 0) return path.resolve(data, DERIVATIVE_DB)
  if (override === ":memory:") return override
  if (path.isAbsolute(override)) throw new Error("opencode-unguarded: OPENCODE_DB must be a filename, not an absolute path")
  if (override.split(/[\\/]/).includes(".."))
    throw new Error("opencode-unguarded: OPENCODE_DB must not contain '..'")
  if (override.includes("/") || override.includes("\\"))
    throw new Error("opencode-unguarded: OPENCODE_DB must be a plain filename inside the profile")
  return path.resolve(data, override)
}
