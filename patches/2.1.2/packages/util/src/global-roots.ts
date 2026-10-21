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
  // These would redirect configuration or home state outside the profile. A
  // launcher rejects them too; refusing here means a direct invocation cannot
  // bypass that policy.
  for (const name of ["OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_TEST_HOME"]) {
    if ((process.env[name] ?? "").length > 0)
      throw new Error(`opencode-unguarded: refusing inherited ${name}; unset it and configure the profile instead`)
  }
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
  // The runtime appends `opencode` below each root. A symlink there would still
  // escape the profile even though the root itself is contained, so validate
  // the application directory too. A missing directory is fine: it is created
  // later, inside the profile.
  for (const base of ["data", "config", "cache", "state", "tmp"]) {
    const appdir = path.join(resolved, base, "opencode")
    if (!fs.existsSync(appdir)) continue
    if (fs.lstatSync(appdir).isSymbolicLink())
      throw new Error(`opencode-unguarded: refusing symlinked application directory: ${appdir}`)
    const canonicalApp = fs.realpathSync.native(appdir)
    if (canonicalApp !== appdir)
      throw new Error(`opencode-unguarded: refusing an application directory that resolves elsewhere: ${canonicalApp}`)
  }
  return resolved
}

/**
 * Resolve the derivative database inside the profile data directory.
 *
 * Overrides are plain filenames; the launcher has the same rule. A symlink at
 * the target would redirect SQLite writes outside the profile, so it is refused
 * for the default filename as well as an override.
 */
export function derivativeDatabasePath(data: string) {
  const override = process.env.OPENCODE_DB
  const name = override === undefined || override.length === 0 ? "opencode-unguarded.db" : override
  if (name === ":memory:") return name
  if (path.isAbsolute(name)) throw new Error("opencode-unguarded: OPENCODE_DB must be a filename, not an absolute path")
  if (name.split(/[\\/]/).includes("..")) throw new Error("opencode-unguarded: OPENCODE_DB must not contain '..'")
  if (name.includes("/") || name.includes("\\"))
    throw new Error("opencode-unguarded: OPENCODE_DB must be a plain filename inside the profile")
  const target = path.join(data, name)
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
    throw new Error(`opencode-unguarded: refusing a symlinked database: ${target}`)
  return target
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
