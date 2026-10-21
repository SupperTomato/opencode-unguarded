import path from "node:path"
import { OPENCODE_CHANNEL, UNGUARDED } from "./version"
import { derivativeDatabasePath } from "@opencode/util/global-roots"

export function databasePath(data: string) {
  // opencode-unguarded: keep the derivative database separate from stock
  // installs while still honoring an explicit override. The launcher already
  // constrains overrides to a plain filename inside the profile; repeating the
  // check here keeps a direct invocation from escaping through OPENCODE_DB.
  if (UNGUARDED) return derivativeDatabasePath(data)
  const filename =
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
