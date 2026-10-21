import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Identity of the installation this process is running from.
 *
 * A launcher-managed installation records a random `installationId` in its
 * BUILD-INFO.json, which distinguishes two installations that share a profile.
 * The recorded identity is only used when the running executable actually lives
 * in that installation; an inherited environment variable cannot claim another
 * installation's identity. Otherwise the identity is derived from the
 * executable's own directory, so the same binary always reports the same
 * installation and a copy elsewhere reports a different one.
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
  const root = process.env.OPENCODE_UNGUARDED_ROOT
  if (root !== undefined && root.length > 0) {
    const canonical = fs.realpathSync.native(path.resolve(root))
    if (isInside(canonicalExecutable, canonical)) {
      const id = readInstallationId(path.join(canonical, "BUILD-INFO.json"))
      if (id !== undefined) return { root: canonical, id, managed: true }
    }
  }
  // No usable installation metadata for this executable: identify its own
  // location so two distinct copies never share service ownership.
  const derived = createHash("sha256").update(path.dirname(canonicalExecutable)).digest("hex").slice(0, 32)
  return { id: `dir:${derived}`, managed: false }
}

/** Whether `target` is the directory `root` or below it. */
export function isInside(target: string, root: string) {
  return target === root || target.startsWith(root + path.sep)
}

/**
 * The installation identifier recorded at install time. A missing or malformed
 * file yields undefined rather than a guess, so a service can never inherit the
 * identity of a different installation by accident.
 */
function readInstallationId(file: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { installationId?: unknown }
    return typeof parsed.installationId === "string" && parsed.installationId.length > 0
      ? parsed.installationId
      : undefined
  } catch {
    return undefined
  }
}

export * as Installation from "./installation.js"
