import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

/**
 * Identity of the installation this process is running from.
 *
 * A launcher-managed installation records a random `installationId` in its
 * BUILD-INFO.json, which distinguishes two installations that share a profile.
 * A raw `libexec/opencode` invocation has no such metadata, so it derives a
 * stable identity from its own executable directory: the same binary always
 * reports the same installation, and a copy elsewhere reports a different one.
 * Neither form is derived from an environment variable.
 */
export type InstallationIdentity = {
  /** Canonical installation root, or undefined for a raw binary invocation. */
  readonly root?: string
  /** Stable identifier for this installation. */
  readonly id: string
  /** Whether the identifier came from installer metadata. */
  readonly managed: boolean
}

export function installationIdentity(executable = process.execPath): InstallationIdentity {
  const root = process.env.OPENCODE_UNGUARDED_ROOT
  if (root !== undefined && root.length > 0) {
    const canonical = fs.realpathSync.native(path.resolve(root))
    const id = readInstallationId(path.join(canonical, "BUILD-INFO.json"))
    if (id !== undefined) return { root: canonical, id, managed: true }
  }
  // No usable installation metadata: identify the binary's own location so two
  // distinct copies never share service ownership.
  const canonical = fs.realpathSync.native(executable)
  const derived = createHash("sha256").update(path.dirname(canonical)).digest("hex").slice(0, 32)
  return { id: `dir:${derived}`, managed: false }
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
