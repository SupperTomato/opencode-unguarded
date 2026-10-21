// opencode-unguarded: telemetry disabled at build time
import pkg from "../../../package.json"

export function desktopVersion() {
  return import.meta.env.OPENCODE_VERSION ?? pkg.version
}

export async function initializeSentry(_version: string) {
  return undefined
}
