import fs from "node:fs"
import os from "os"
import path from "path"

declare const OPENCODE_UNGUARDED: boolean | undefined

const home = os.homedir()

// The derivative never falls back to stock OpenCode application storage. The
// launcher sets OPENCODE_UNGUARDED_PROFILE; a direct invocation of
// `libexec/opencode` uses the same default profile instead of the stock XDG
// roots, so it cannot read or write stock sessions, config, logs, or cache.
const derivative = typeof OPENCODE_UNGUARDED === "boolean" && OPENCODE_UNGUARDED

function defaultProfile() {
  // Match the launcher exactly: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode-unguarded/profile`.
  const data = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.join(data, "opencode-unguarded", "profile")
}

/**
 * Resolve the derivative profile, rejecting values that would escape it.
 *
 * This runs where the global roots are first computed, which is before any
 * directory is created or log file is opened, so a rejected profile leaves no
 * trace on disk. The launcher applies the same policy; keeping it here as well
 * means invoking `libexec/opencode` directly cannot bypass it.
 *
 * The default is validated like any explicit value. Returning it early would
 * let a symlinked default profile redirect storage into stock OpenCode through
 * a direct invocation.
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
  if (raw !== undefined && raw.length === 0)
    throw new Error("opencode-unguarded: OPENCODE_UNGUARDED_PROFILE is set but empty; unset it to use the default")
  const requested = raw ?? defaultProfile()
  if (!path.isAbsolute(requested))
    throw new Error(`opencode-unguarded: OPENCODE_UNGUARDED_PROFILE must be absolute (got: ${requested})`)
  // Normalize so `..` components cannot pass a lexical prefix check.
  const resolved = path.resolve(requested)
  if (resolved === path.parse(resolved).root)
    throw new Error("opencode-unguarded: refusing the filesystem root as the application profile")

  // The profile root itself may be a link. A dangling link resolves to its own
  // lexical path, so the ancestor comparison below cannot see the redirect;
  // after the launcher has created the target it would point somewhere else.
  try {
    if (fs.lstatSync(resolved).isSymbolicLink())
      throw new Error(
        `opencode-unguarded: refusing a symlinked application profile: ${resolved} -> ${safeLink(resolved)}`,
      )
  } catch (error) {
    if (error instanceof Error && error.message.includes("refusing a symlinked")) throw error
  }

  // Compare both the requested path and its canonical form, so a symlinked
  // ancestor cannot redirect the profile into stock storage.
  const candidates = new Set([resolved])
  const canonical = canonicalExistingAncestor(resolved)
  if (canonical !== undefined) candidates.add(canonical)
  for (const candidate of candidates) {
    for (const directory of stockRoots(resolved)) {
      if (overlaps(candidate, directory))
        throw new Error(`opencode-unguarded: refusing a profile overlapping stock OpenCode storage: ${candidate}`)
    }
  }

  // The runtime appends `opencode` below each root. A symlink anywhere between
  // the profile and that directory would escape even though the root is
  // contained, so no existing component may be a link. A missing directory is
  // fine: it is created later, inside the profile.
  for (const base of ["data", "config", "cache", "state", "tmp"]) {
    const appdir = path.join(resolved, base, "opencode")
    assertNoLinkComponents(resolved, appdir)
  }
  // An application directory being real is not enough: a symlinked log
  // directory, configuration file, credential file, or service record inside it
  // would still redirect an application write into stock storage. Check the
  // direct children of the directories the application writes through; this is
  // bounded work and happens before any write.
  for (const base of ["data", "config", "cache", "state"]) {
    assertNoLinkedChildren(path.join(resolved, base, "opencode"))
  }
  return resolved
}

/**
 * Reject symlinks or non-regular entries among a directory's direct children.
 *
 * Only direct children are inspected: application configuration, credentials,
 * service records, database files, and logs live at that level, while deep
 * session and repository trees are not write targets that a link could
 * silently redirect to stock storage.
 */
function assertNoLinkedChildren(directory: string) {
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch {
    return
  }
  for (const name of entries) {
    const target = path.join(directory, name)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      continue
    }
    if (stat.isSymbolicLink())
      throw new Error(`opencode-unguarded: refusing symlinked application storage: ${target} -> ${safeLink(target)}`)
  }
}

/**
 * Stock application storage that is actually in use.
 *
 * Conventional paths are not enough: a user may set XDG_DATA_HOME and keep
 * stock sessions somewhere else. Both the environment-derived and the
 * conventional locations are protected, in lexical and canonical form.
 */
function stockRoots(profile: string) {
  const data = process.env.XDG_DATA_HOME || path.join(home, ".local", "share")
  const config = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  const cache = process.env.XDG_CACHE_HOME || path.join(home, ".cache")
  const state = process.env.XDG_STATE_HOME || path.join(home, ".local", "state")
  const roots = [
    path.join(data, "opencode"),
    path.join(config, "opencode"),
    path.join(cache, "opencode"),
    path.join(state, "opencode"),
    path.join(home, ".local", "share", "opencode"),
    path.join(home, ".config", "opencode"),
    path.join(home, ".cache", "opencode"),
    path.join(home, ".local", "state", "opencode"),
  ]
  const expanded = roots.flatMap((root) => {
    const canonical = canonicalExistingAncestor(root)
    return canonical === undefined ? [root] : [root, canonical]
  })
  // The launcher exports XDG_* pointing inside the profile before starting the
  // executable, so those values must not be mistaken for stock storage: a
  // candidate that overlaps the profile is the derivative's own directory.
  // Only descendants of the profile are the derivative's own directories. A
  // stock root that contains the candidate must still be refused, so an
  // ancestor overlap is never filtered out.
  return [...new Set(expanded)].filter((root) => !(root === profile || root.startsWith(profile + path.sep)))
}

/** Whether two paths are equal or one contains the other. */
export function overlaps(left: string, right: string) {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)
}

/**
 * Reject a symlink on any existing component below `root`.
 *
 * `lstat` is used so a dangling link is detected; `existsSync` would follow it
 * and report "missing", letting a later recursive mkdir traverse it.
 */
export function assertNoLinkComponents(root: string, target: string) {
  const relative = path.relative(root, target)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return
  let current = root
  for (const part of relative.split(path.sep).filter((value) => value.length > 0)) {
    current = path.join(current, part)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch {
      // Missing components are created later, inside the validated root.
      return
    }
    if (stat.isSymbolicLink())
      throw new Error(`opencode-unguarded: refusing symlinked storage: ${current} -> ${safeLink(current)}`)
    if (!stat.isDirectory())
      throw new Error(`opencode-unguarded: refusing a non-directory in the storage path: ${current}`)
  }
}

function safeLink(target: string) {
  try {
    return fs.readlinkSync(target)
  } catch {
    return "unknown"
  }
}

/**
 * Resolve the derivative database inside the profile data directory.
 *
 * Overrides are plain filenames; the launcher has the same rule. A symlink at
 * the target would redirect SQLite writes outside the profile, so it is refused
 * for the default filename as well as an override. SQLite creates `-wal` and
 * `-shm` beside the database, and may create a `-journal`, so those existing
 * files are checked too: a link there would move writes and permission changes
 * outside the profile.
 */
export function derivativeDatabasePath(data: string) {
  const override = process.env.OPENCODE_DB
  const name = override === undefined || override.length === 0 ? "opencode-unguarded.db" : override
  if (name === ":memory:") return name
  if (path.isAbsolute(name)) throw new Error("opencode-unguarded: OPENCODE_DB must be a filename, not an absolute path")
  if (name.split(/[\\/]/).includes("..")) throw new Error("opencode-unguarded: OPENCODE_DB must not contain '..'")
  if (name.includes("/") || name.includes("\\"))
    throw new Error("opencode-unguarded: OPENCODE_DB must be a plain filename inside the profile")
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = path.join(data, name + suffix)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(target)
    } catch {
      continue
    }
    if (stat.isSymbolicLink())
      throw new Error(`opencode-unguarded: refusing a symlinked database file: ${target}`)
    if (!stat.isFile())
      throw new Error(`opencode-unguarded: refusing a non-file database path: ${target}`)
    if (stat.nlink > 1)
      throw new Error(`opencode-unguarded: refusing a hard-linked database file: ${target}`)
  }
  return path.join(data, name)
}

/**
 * Validate a file the application is about to write below the profile.
 *
 * Validating the profile roots is not enough: a symlinked log directory, global
 * configuration file, or credential file would still redirect a write into
 * stock storage. Every existing component between the profile and the target
 * must be a real directory (or the target a real file), and the target's parent
 * must resolve inside the profile.
 */
export function derivativeWriteTarget(profile: string, target: string) {
  const relative = path.relative(profile, target)
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`opencode-unguarded: refusing a write outside the profile: ${target}`)
  const parent = path.dirname(target)
  assertNoLinkComponents(profile, parent)
  const canonical = canonicalExistingAncestor(parent)
  if (canonical !== undefined) {
    const root = canonicalExistingAncestor(profile)
    if (root !== undefined && !isInside(canonical, root))
      throw new Error(`opencode-unguarded: refusing a write that resolves outside the profile: ${target}`)
  }
  return target
}

function isInside(target: string, root: string) {
  return target === root || target.startsWith(root + path.sep)
}

/**
 * Canonicalize a path whose leaf may not exist yet by resolving the nearest
 * existing ancestor. Returns undefined when nothing can be resolved, so callers
 * decide rather than trusting an unverified input.
 */
function canonicalExistingAncestor(target: string): string | undefined {
  try {
    let current = target
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current)
      if (parent === current) return undefined
      current = parent
    }
    const canonical = fs.realpathSync.native(current)
    return path.join(canonical, path.relative(current, target))
  } catch {
    return undefined
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
