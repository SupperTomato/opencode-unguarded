#!/usr/bin/env bun

/**
 * Apply the reviewed derivative patch set to a pinned upstream checkout.
 *
 * Each manifest entry names a SHA-256 for the exact upstream input and the
 * exact reviewed output. The output bytes live in `patches/<version>/`, so the
 * transformation is never re-derived from anchors at build time. A tree must be
 * wholly pristine or wholly final; anything else is rejected before any write.
 */

import fs from "node:fs"
import path from "node:path"
import {
  applyRoot,
  positional,
  assertRelativePath,
  cliRoot,
  commit,
  exists,
  fail,
  loadManifest,
  manifestPath,
  occurrences,
  plan,
  read,
  repoRoot,
  resolveTarget,
  sha256,
  validateManifest,
  verify,
  verifyUpstreamIdentity,
  verifyWorktreeIdentity,
  type Change,
  type Manifest,
  type Planned,
} from "./lib/patch"

export {
  applyRoot,
  exists,
  loadManifest,
  manifestPath,
  occurrences,
  plan,
  read,
  repoRoot,
  resolveTarget,
  sha256,
  validateManifest,
  verify,
  verifyUpstreamIdentity,
  verifyWorktreeIdentity,
}
export type { Change, Manifest, Planned }

/** Directory holding the reviewed final bytes for a manifest. */
export function patchDir(version: string) {
  return path.join(repoRoot(), "patches", version)
}

function loadFinal(version: string, file: string) {
  assertRelativePath(file, file)
  const full = path.join(patchDir(version), file)
  if (!fs.existsSync(full)) fail(`missing reviewed output for ${file}: ${full}`)
  const content = fs.readFileSync(full, "utf8")
  return content
}

/**
 * Map each declared file to a transformation that ignores the input and yields
 * the reviewed bytes. Input identity is already pinned by the pristine digest,
 * so this cannot mask source drift.
 */
export function transforms(manifest: Manifest) {
  const root = patchDir(manifest.upstream.version)
  return new Map(
    manifest.files.map((entry) => [
      entry.file,
      (_content: string) => {
        const full = path.join(root, entry.file)
        if (!fs.existsSync(full)) fail(`missing reviewed output for ${entry.file}: ${full}`)
        return fs.readFileSync(full, "utf8")
      },
    ]),
  )
}

/**
 * Apply the reviewed patch set to a verified source tree.
 *
 * Identity is enforced here, not only in the CLI: a caller importing this
 * module gets the same guarantee, so byte transformation can never be used to
 * write into an unverified tree.
 */
export function apply(root: string, manifest: Manifest) {
  verifyUpstreamIdentity(root, manifest)
  return applyRoot(root, manifest, transforms(manifest))
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const version = positional(args, ["--root"])[0]
  if (!version) {
    console.error(
      "usage: bun script/unguarded/apply.ts <upstream-version> [--root <dir>] [--check] [--verify-worktree]",
    )
    process.exit(2)
  }
  const root = cliRoot(args)
  const check = args.includes("--check")
  // The derivative repository contains payloads, scripts, and tests that are
  // not part of the assembled upstream tree. Worktree identity therefore applies
  // to an assembled source tree only, and is requested explicitly.
  const worktree = args.includes("--verify-worktree")
  const manifest = loadManifest(version)

  try {
    // Identity is enforced in both modes. `--check` verifies a tree; skipping
    // source identity there would let validation approve an unrelated source.
    verifyUpstreamIdentity(root, manifest)
    if (!check) {
      // Applying is the only writer: plan validates the whole tree first, so a
      // rejected plan leaves no changes behind.
      const changes = applyRoot(root, manifest, transforms(manifest))
      for (const change of changes) console.log(`patched ${change.file}: ${change.reason}`)
      if (changes.length === 0) console.log("no changes needed (already patched)")
    }
    const errors = [...verify(root, manifest), ...(worktree ? verifyWorktreeIdentity(root, manifest) : [])]
    if (errors.length > 0) {
      console.error("Guardrail verification failed:")
      for (const error of errors) console.error(`- ${error}`)
      process.exit(1)
    }
    console.log(
      `guardrail verification passed for upstream ${manifest.upstream.version} (${manifest.upstream.commit.slice(0, 8)})`,
    )
  } catch (error) {
    console.error(`guardrail patch failed: ${(error as Error).message}`)
    process.exit(1)
  }
}
