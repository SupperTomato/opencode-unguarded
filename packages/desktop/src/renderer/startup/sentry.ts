import pkg from "../../../package.json"

// opencode-unguarded: desktop error reporting is removed at build time.
export function desktopVersion() {
  return import.meta.env.OPENCODE_VERSION ?? pkg.version
}

export async function initializeSentry(_version: string) {
  return undefined
}
