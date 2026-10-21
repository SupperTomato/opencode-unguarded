import os from "os"
import path from "path"

declare const OPENCODE_UNGUARDED: boolean | undefined

const home = os.homedir()

// The derivative never falls back to stock OpenCode application storage. The
// launcher sets OPENCODE_UNGUARDED_PROFILE; a direct invocation of
// `libexec/opencode` uses this same default profile instead of the stock XDG
// roots, so it cannot read or write stock sessions, config, logs, or cache.
const derivative = typeof OPENCODE_UNGUARDED === "boolean" && OPENCODE_UNGUARDED

function derivativeProfile() {
  return process.env.OPENCODE_UNGUARDED_PROFILE ?? path.join(home, ".local", "share", "opencode-unguarded", "profile")
}

/** The XDG base directories that root opencode's global paths. */
export function roots(app: string) {
  if (derivative) {
    // Keep the same `<profile>/<base>/opencode` layout the launcher validates,
    // so existing profiles and the launcher's containment checks agree.
    const profile = derivativeProfile()
    return {
      data: path.join(profile, "data", app),
      cache: path.join(profile, "cache", app),
      config: path.join(profile, "config", app),
      state: path.join(profile, "state", app),
      tmp: path.join(profile, "tmp", app),
    }
  }
  const data = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : undefined)
  const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, ".cache") : undefined)
  const config = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)
  const state = process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)
  return {
    data: path.join(data!, app),
    cache: path.join(cache!, app),
    config: path.join(config!, app),
    state: path.join(state!, app),
    tmp: path.join(os.tmpdir(), app),
  }
}
