import fs from "node:fs"
import os from "os"
import path from "path"

declare const OPENCODE_UNGUARDED: boolean | undefined

const home = os.homedir()

// The derivative never falls back to stock OpenCode application storage. The
// launcher sets OPENCODE_UNGUARDED_PROFILE; a direct invocation of
// `libexec/opencode` uses this same default profile instead of the stock XDG
// roots, so it cannot read or write stock sessions, config, logs, or cache.
const derivative = typeof OPENCODE_UNGUARDED === "boolean" && OPENCODE_UNGUARDED

const DEFAULT_PROFILE = path.join(home, ".local", "share", "opencode-unguarded", "profile")

/**
 * Resolve the derivative profile, rejecting values that would escape it.
 *
 * This runs where the global roots are first computed, which is before any
 * directory is created or log file is opened, so a rejected profile leaves no
 * trace on disk. The launcher applies the same policy; keeping it here as well
 * means invoking `libexec/opencode` directly cannot bypass it.
 */
function derivativeProfile() {
  const raw = process.env.OPENCODE_UNGUARDED_PROFILE
  if (raw === undefined || raw.length === 0) return DEFAULT_PROFILE
  if (!path.isAbsolute(raw))
    throw new Error(`opencode-unguarded: OPENCODE_UNGUARDED_PROFILE must be absolute (got: ${raw})`)
  // Normalize so `..` components cannot pass a lexical prefix check.
  const resolved = path.resolve(raw)
  if (resolved === path.parse(resolved).root)
    throw new Error("opencode-unguarded: refusing the filesystem root as the application profile")
  const stock = [
    path.join(home, ".local", "share", "opencode"),
    path.join(home, ".config", "opencode"),
    path.join(home, ".cache", "opencode"),
    path.join(home, ".local", "state", "opencode"),
  ]
  // Compare both the requested path and its canonical form, so a symlinked
  // ancestor cannot redirect the profile into stock storage.
  for (const candidate of [resolved, canonicalExistingAncestor(resolved)]) {
    for (const directory of stock) {
      if (candidate === directory || candidate.startsWith(directory + path.sep))
        throw new Error(
          `opencode-unguarded: refusing a profile inside stock OpenCode storage: ${candidate}`,
        )
    }
  }
  return resolved
}

/**
 * Canonicalize a path whose leaf may not exist yet by resolving the nearest
 * existing ancestor. Returns the input when nothing exists or resolution fails.
 */
function canonicalExistingAncestor(target: string) {
  try {
    let current = target
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) return target
      current = parent
    }
    const canonical = fs.realpathSync.native(current)
    return path.join(canonical, path.relative(current, target))
  } catch {
    return target
  }
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

/** Whether this build is the derivative. */
export function isDerivative() {
  return derivative
}
