import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Identity of the installation this process is running from.
 *
 * A packaged installation records a random `installationId` in
 * `<root>/BUILD-INFO.json`, which distinguishes two installations that share a
 * profile. The identity is derived from where the running executable actually
 * lives, not from an environment variable: the launcher and a direct invocation
 * of `libexec/opencode` must agree, and an inherited variable must not be able
 * to claim another installation's identity.
 *
 * The managed layout is `<root>/libexec/opencode` with a sibling
 * `BUILD-INFO.json`. That metadata is trusted only when the file is not a
 * symlink and its recorded executable hash matches the running bytes; a copy of
 * the binary in a hand-made directory therefore gets its own derived identity
 * instead of borrowing someone else's.
 */
export type InstallationIdentity = {
  /** Canonical installation root, or undefined when the identity is derived from the binary. */
  readonly root?: string
  /** Stable identifier for this installation. */
  readonly id: string
  /** Whether the identifier came from installer metadata. */
  readonly managed: boolean
}

export function installationIdentity(executable = process.execPath): InstallationIdentity {
  const canonicalExecutable = fs.realpathSync.native(executable)
  const root = managedRoot(canonicalExecutable)
  if (root !== undefined) {
    const id = metadataId(root, canonicalExecutable)
    if (id !== undefined) return { root, id, managed: true }
  }
  // No usable installation metadata for this executable: identify its own
  // location so two distinct copies never share service ownership.
  const derived = createHash("sha256").update(path.dirname(canonicalExecutable)).digest("hex").slice(0, 32)
  return { id: `dir:${derived}`, managed: false }
}

/**
 * The installation root this executable provably belongs to, if any.
 *
 * The layout is authoritative. A launcher-supplied root is accepted only when
 * the running executable is exactly `<root>/libexec/opencode`, so an inherited
 * variable cannot point at an unrelated directory that happens to contain a
 * copy of the binary.
 */
function managedRoot(canonicalExecutable: string) {
  const libexec = path.dirname(canonicalExecutable)
  const layoutRoot = path.basename(libexec) === "libexec" ? path.dirname(libexec) : undefined
  // The executable's own location is authoritative; a claimed root is only a
  // consistency check for diagnostics and never changes the answer.
  if (path.basename(canonicalExecutable) !== "opencode") return undefined
  return layoutRoot
}

/**
 * The installation identifier recorded at install time, when the metadata is
 * genuinely this installation's. A symlinked metadata file is refused: it could
 * redirect the read to another installation.
 */
function metadataId(root: string, canonicalExecutable: string) {
  const file = path.join(root, "BUILD-INFO.json")
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined
  let parsed: { installationId?: unknown; executableSha256?: unknown }
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as typeof parsed
  } catch {
    return undefined
  }
  if (typeof parsed.installationId !== "string" || parsed.installationId.length === 0) return undefined
  // The metadata must describe this executable. Without the check, a copy of
  // the binary placed inside another installation's directory would inherit its
  // service ownership.
  if (typeof parsed.executableSha256 !== "string") return undefined
  let digest: string
  try {
    digest = createHash("sha256").update(fs.readFileSync(canonicalExecutable)).digest("hex")
  } catch {
    return undefined
  }
  if (digest !== parsed.executableSha256) return undefined
  return parsed.installationId
}

/** Whether `target` is the directory `root` or below it. */
export function isInside(target: string, root: string) {
  return target === root || target.startsWith(root + path.sep)
}

export * as Installation from "./installation.js"
