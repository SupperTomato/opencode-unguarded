import { confirm, intro, log, outro, spinner } from "@clack/prompts"
import { Service } from "@opencode/client/effect/service"
import { parseRegistration } from "@opencode/client/service-registration-decoder"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Option, Schedule, Schema } from "effect"
import path from "node:path"
import { createHash } from "node:crypto"
import { UNGUARDED, UNGUARDED_IDENTITY } from "../../version"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { RetainedImage } from "../../services/retained-image"
import { Updater } from "../../services/updater"
import { handlePromptErrors, prompt, requireInteractive } from "../../ui/prompt"
import { errorMessage } from "../../util/error"

export default Runtime.handler(
  Commands.commands.uninstall,
  Effect.fn("cli.uninstall")(function* (input) {
    // opencode-unguarded: the derivative removes only what it installed. It
    // never runs an upstream package-manager removal, never edits shell
    // profiles, and never touches global caches shared with stock OpenCode.
    if (UNGUARDED) return yield* uninstallDerivative(input)
    intro("Uninstall OpenCode")
    const fs = yield* FileSystem.FileSystem
    const global = yield* Global.Service
    const updater = yield* Updater.Service
    const method = yield* updater.method()
    const removal = method ? updater.removal(method) : undefined
    // Data, config, and state hold sessions, credentials, settings, and prompt history; uninstall only removes the cache.
    // All channels share the cache. Stop background services before deleting it.
    // Read registrations directly: ServiceConfig.options() can migrate files even during a dry run.
    const services = (yield* fs.exists(global.state))
      ? (yield* fs.readDirectory(global.state)).filter((name) => /^service(?:-.*)?\.json$/.test(name))
      : []
    const shell = method === "curl" ? yield* shellConfigs(global.home) : []

    log.info(`Installation method: ${method ?? "unknown"}`)
    log.message("The following global files will be removed (shared by OpenCode versions and channels):")
    if (yield* fs.exists(global.cache)) log.info(`  Cache: ${global.cache}`)
    services.forEach((name) =>
      log.info(`  Stop background service and persistent terminals: ${path.join(global.state, name)}`),
    )
    shell.forEach((file) => log.info(`  Shell PATH: ${file}`))
    if (removal) log.info(`  Package: ${removal.command.join(" ")}`)
    if (method === "curl") log.info(`  Binary (manual removal): ${process.execPath}`)
    if (!method) log.warn("Could not detect the installation method. Remove the installation manually after cleanup.")

    if (input.dryRun) {
      log.warn("Dry run - no changes made")
      outro("Done")
      return
    }
    if (!input.force) {
      yield* requireInteractive("Use --force to uninstall without an interactive terminal, or --dry-run to preview.")
      const accepted = yield* prompt(() =>
        confirm({ message: "Are you sure you want to uninstall?", initialValue: false }),
      )
      if (!accepted) {
        outro("Cancelled")
        return
      }
    }

    const progress = spinner()
    if (services.length) {
      progress.start("Stopping background services...")
      yield* Effect.forEach(services, (name) =>
        Effect.gen(function* () {
          const options = { file: path.join(global.state, name) }
          yield* ServerConnection.shutdownPersistentPty(options).pipe(Effect.ignore)
          yield* Service.stop(options)
        }),
      ).pipe(
        Effect.tap(() => Effect.sync(() => progress.stop("Background services stopped"))),
        Effect.tapCause(() => Effect.sync(() => progress.stop("Failed to stop background services", 1))),
      )
    }

    // Links that keep an older OpenCode replaceable may still run; move them so the cache can go.
    if (process.platform === "win32") yield* RetainedImage.relocate(global.cache, global.tmp)
    const errors: string[] = []
    progress.start("Removing Cache...")
    yield* fs.remove(global.cache, { recursive: true, force: true }).pipe(
      // Windows reports a terminated service as gone before it releases its file handles,
      // so the first removal can race that teardown.
      Effect.retry({
        while: (error) => process.platform === "win32" && error.reason._tag === "Busy",
        schedule: Schedule.max([Schedule.spaced("250 millis"), Schedule.recurs(40)]),
      }),
      Effect.tap(() => Effect.sync(() => progress.stop("Removed Cache"))),
      Effect.catch((error) =>
        Effect.sync(() => {
          progress.stop("Failed to remove Cache", 1)
          errors.push(`Cache: ${errorMessage(error)}`)
        }),
      ),
    )
    yield* Effect.forEach(shell, (file) =>
      fs.readFileString(file).pipe(
        Effect.flatMap((content) => fs.writeFileString(file, cleanShellConfig(content))),
        Effect.catch((error) => Effect.sync(() => errors.push(`Shell config ${file}: ${errorMessage(error)}`))),
      ),
    )
    if (removal) {
      progress.start(`Running ${removal.command.join(" ")}...`)
      yield* removal.run.pipe(
        Effect.tap(() => Effect.sync(() => progress.stop("Package removed"))),
        Effect.catch((error) =>
          Effect.sync(() => {
            progress.stop("Package manager uninstall failed", 1)
            errors.push(errorMessage(error))
            log.warn(`Run manually: ${removal.command.join(" ")}`)
          }),
        ),
      )
    }
    if (method === "curl") {
      log.message("To finish removing the binary, run:")
      log.info(`  rm '${process.execPath.replaceAll("'", "'\\''")}'`)
    }
    if (errors.length) yield* Effect.fail(new Error(errors.join("\n")))
    outro("Done")
  }, handlePromptErrors),
)

const shellConfigs = Effect.fnUntraced(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const bin = path.dirname(process.execPath)
  // V1 and V2 curl installs share a PATH entry; retain it while another binary uses it.
  if ((yield* fs.readDirectory(bin)).some((name) => name !== path.basename(process.execPath))) return []
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
  const zsh = process.env.ZDOTDIR || home
  const candidates: Record<string, string[]> = {
    fish: [path.join(home, ".config/fish/config.fish"), path.join(xdg, "fish/config.fish")],
    zsh: [
      path.join(zsh, ".zshrc"),
      path.join(zsh, ".zshenv"),
      path.join(xdg, "zsh/.zshrc"),
      path.join(xdg, "zsh/.zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdg, "bash/.bashrc"),
      path.join(xdg, "bash/.bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".ashrc"), path.join(home, ".profile")],
  }
  const files = [...new Set(candidates[path.basename(process.env.SHELL || "bash")] ?? candidates.bash)]
  return yield* Effect.filter(files, (file) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => cleanShellConfig(content) !== content),
      Effect.orElseSucceed(() => false),
    ),
  )
})

function cleanShellConfig(content: string) {
  const lines = content.split("\n")
  const entry = (line: string) =>
    /^(?:export PATH=|fish_add_path\s)/.test(line.trim()) && line.includes(".opencode/bin")
  return lines
    .filter((line, index) => !entry(line) && !(line.trim() === "# opencode" && entry(lines[index + 1] ?? "")))
    .join("\n")
}

// Removal plan for the derivative installation. The launcher sets
// OPENCODE_UNGUARDED_ROOT to the directory containing bin/ and libexec/;
// without it this refuses rather than guessing from the executable path.
const uninstallDerivative = Effect.fn("cli.uninstall.derivative")(function* (input: {
  readonly dryRun: boolean
  readonly force: boolean
}) {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const installation = process.env.OPENCODE_UNGUARDED_ROOT

  intro(`Uninstall ${UNGUARDED_IDENTITY.name}`)
  log.message("This removes the candidate program and its background service.")

  if (!installation) {
    log.warn("OPENCODE_UNGUARDED_ROOT is not set; refusing to guess an installation directory.")
    log.info("Run the packaged bin/opencode-unguarded launcher, or remove the program directory manually.")
    return yield* Effect.fail(new Error("refusing to uninstall without a verified installation root"))
  }

  const root = path.resolve(installation)
  const binary = path.join(root, "libexec", "opencode")
  const launcher = path.join(root, "bin", "opencode-unguarded")
  if (!(yield* fs.exists(launcher)) || !(yield* fs.exists(binary)))
    return yield* Effect.fail(new Error(`refusing to remove ${root}: it is not an opencode-unguarded installation`))

  const rootReal = yield* fs.realPath(root)
  // Prove this process belongs to that installation. An environment variable
  // is only a claim; the executable's own location and the installation
  // metadata are what make it true.
  const verified = yield* verifyInstallationOwnership(fs, rootReal)
  if (typeof verified === "string") return yield* Effect.fail(new Error(verified))
  const ownership = verified

  // An installation that contains the profile cannot be removed without
  // deleting durable data. Refuse before listing or stopping anything.
  // global.data is <profile>/data/opencode. A profile that does not exist yet
  // has no canonical path, and a dry run must not create it, so normalize
  // lexically in that case.
  const profilePath = path.dirname(path.dirname(global.data))
  const canonicalProfile = yield* fs.realPath(profilePath).pipe(Effect.option)
  const profileRoot = Option.getOrElse(canonicalProfile, () => path.resolve(profilePath))
  if (rootReal === profileRoot || rootReal.startsWith(profileRoot + path.sep) || profileRoot.startsWith(rootReal + path.sep))
    return yield* Effect.fail(
      new Error(
        `refusing to remove ${rootReal}: it overlaps the application profile (${profileRoot}). ` +
          `Move the profile with OPENCODE_UNGUARDED_PROFILE, then uninstall.`,
      ),
    )

  // The whole root is deleted recursively, so every entry must be a program file
  // this installer writes. A durable profile or an unrelated file inside the
  // root means the directory is not exclusively ours.
  const unexpected = yield* unexpectedEntries(fs, rootReal)
  if (unexpected.length > 0)
    return yield* Effect.fail(
      new Error(
        `refusing to remove ${rootReal}: it contains entries an installation does not own ` +
          `(${unexpected.slice(0, 5).join(", ")}${unexpected.length > 5 ? ", ..." : ""}). ` +
          `Move them out, then uninstall.`,
      ),
    )

  const registration = path.join(global.state, "service-unguarded.json")
  const registered = yield* readRegistration(fs, registration)
  // A registration that cannot be read is not evidence that no service exists.
  // Only a genuinely absent file is. A malformed one is reported, and removal
  // stops so the user can inspect it instead of deleting a running program.
  if (registered._tag === "invalid")
    return yield* Effect.fail(
      new Error(
        `refusing to remove ${rootReal}: ${registration} exists but is not a readable service registration. ` +
          `Inspect or remove it, then uninstall.`,
      ),
    )
  const owned = registered._tag === "valid" ? registered.info : undefined
  // A registration that is not provably this installation's service may belong
  // to a live process we must not delete the program out from under. Refuse and
  // let the user resolve it; never proceed on a warning.
  if (owned !== undefined && !registrationBelongsToInstallation(owned, ownership))
    return yield* Effect.fail(
      new Error(
        `refusing to remove ${rootReal}: ${registration} belongs to another build, revision, or installation. ` +
          `Stop that service, then uninstall.`,
      ),
    )
  const stop = owned
  const command = yield* findCommandLink(fs, launcher, global.home)

  log.message("Sessions, credentials, configuration, and other profile data are kept.")
  log.info(`  Installation: ${rootReal}`)
  log.info(`  Service registration: ${registration}`)
  if (stop) log.info(`  Background service: pid ${stop.pid}`)

  if (input.dryRun) {
    log.warn("Dry run - no changes made")
    outro("Done")
    return
  }
  if (!input.force) {
    yield* requireInteractive("Use --force to uninstall without an interactive terminal, or --dry-run to preview.")
    const accepted = yield* prompt(() =>
      confirm({ message: `Remove ${UNGUARDED_IDENTITY.name} from ${rootReal}?`, initialValue: false }),
    )
    if (!accepted) {
      outro("Cancelled")
      return
    }
  }

  const progress = spinner()
  const errors: string[] = []
  if (stop) {
    progress.start("Stopping the derivative service...")
    yield* ServerConnection.shutdownPersistentPty({
      file: registration,
      installation: ownership.installationId,
    }).pipe(Effect.ignore)
    yield* Service.stop({ file: registration, installation: ownership.installationId }).pipe(
      Effect.tap(() => Effect.sync(() => progress.stop("Derivative service stopped"))),
      Effect.catch((error) =>
        Effect.sync(() => {
          progress.stop("Failed to stop the derivative service", 1)
          errors.push(errorMessage(error))
        }),
      ),
    )
    // A service that refuses to stop would keep running against a deleted
    // installation, so removal does not proceed.
    if (errors.length > 0) return yield* Effect.fail(new Error(errors.join("\n")))
  }

  progress.start("Removing the derivative installation...")
  yield* fs.remove(rootReal, { recursive: true, force: true }).pipe(
    Effect.tap(() => Effect.sync(() => progress.stop("Removed the derivative installation"))),
    Effect.catch((error) =>
      Effect.sync(() => {
        progress.stop("Failed to remove the derivative installation", 1)
        errors.push(errorMessage(error))
      }),
    ),
  )
  if (command) yield* fs.remove(command).pipe(Effect.catch((error) => Effect.sync(() => errors.push(errorMessage(error)))))
  if (errors.length) return yield* Effect.fail(new Error(errors.join("\n")))
  outro("Done")
})

type Ownership = { readonly executable: string; readonly installationId?: string; readonly root: string }

/**
 * Prove that the running executable belongs to the installation being removed.
 *
 * The launcher sets OPENCODE_UNGUARDED_ROOT, but an environment variable can be
 * set by anyone. Requiring both a UUID installation identifier from
 * BUILD-INFO.json and a running executable inside that root means two decoy
 * files at an arbitrary path are not enough: the process has to actually be
 * the installed program.
 */
const verifyInstallationOwnership = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const metadata = path.join(root, "BUILD-INFO.json")
    const text = yield* fs.readFileString(metadata).pipe(Effect.option)
    if (Option.isNone(text)) return `refusing to remove ${root}: it has no BUILD-INFO.json`
    const info = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BuildInfo))(text.value).pipe(Effect.option)
    if (Option.isNone(info)) return `refusing to remove ${root}: its BUILD-INFO.json is not valid installation metadata`
    if (info.value.derivative !== UNGUARDED_IDENTITY.name)
      return `refusing to remove ${root}: it is not an opencode-unguarded installation`
    if (info.value.derivativeRevision !== UNGUARDED_IDENTITY.revision)
      return (
        `refusing to remove ${root}: it was installed by derivative revision ` +
        `${info.value.derivativeRevision ?? "<unknown>"}, but this executable is revision ${UNGUARDED_IDENTITY.revision}`
      )
    const installed = yield* fs.realPath(path.join(root, "libexec", "opencode")).pipe(Effect.option)
    const running = yield* fs.realPath(process.execPath).pipe(Effect.option)
    if (Option.isNone(installed) || Option.isNone(running))
      return `refusing to remove ${root}: its executable could not be resolved`
    // The executable must resolve inside the root, not merely equal a symlink
    // target elsewhere, and its bytes must match the recorded hash. Without
    // both, an unrelated directory with a link to this binary would qualify.
    if (!isInside(installed.value, root))
      return `refusing to remove ${root}: its executable resolves outside the installation (${installed.value})`
    if (installed.value !== running.value)
      return (
        `refusing to remove ${root}: the running executable (${process.execPath}) is not the one installed there ` +
        `(${installed.value})`
      )
    if (info.value.executableSha256 === undefined)
      return `refusing to remove ${root}: BUILD-INFO.json does not record the executable hash`
    if (info.value.launcherSha256 === undefined)
      return `refusing to remove ${root}: BUILD-INFO.json does not record the launcher hash`
    const installedLauncher = yield* fs.realPath(path.join(root, "bin", "opencode-unguarded")).pipe(Effect.option)
    if (Option.isNone(installedLauncher) || !isInside(installedLauncher.value, root))
      return `refusing to remove ${root}: its launcher resolves outside the installation`
    const launcherDigest = yield* sha256File(fs, installedLauncher.value).pipe(Effect.option)
    if (Option.isNone(launcherDigest)) return `refusing to remove ${root}: its launcher could not be read`
    if (launcherDigest.value !== info.value.launcherSha256)
      return `refusing to remove ${root}: its launcher does not match BUILD-INFO.json`
    const actual = yield* sha256File(fs, installed.value).pipe(Effect.option)
    if (Option.isNone(actual)) return `refusing to remove ${root}: its executable could not be read`
    if (actual.value !== info.value.executableSha256)
      return `refusing to remove ${root}: its executable does not match BUILD-INFO.json`
    return {
      executable: installed.value,
      installationId: info.value.installationId,
      root,
    } satisfies Ownership
  })

const BuildInfo = Schema.Struct({
  derivative: Schema.optional(Schema.String),
  derivativeRevision: Schema.optional(Schema.String),
  installationId: Schema.optional(Schema.String),
  executableSha256: Schema.optional(Schema.String),
  launcherSha256: Schema.optional(Schema.String),
})

/**
 * Program files a packaged installation may contain. Removal verifies that
 * every entry under the root is part of this inventory before deleting
 * anything; an unexpected file means the directory is not exclusively ours, and
 * a recursive delete could destroy unrelated data.
 */
const OWNED_FILES = new Set([
  "BUILD-INFO.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "acceptance.sh",
  "bin/opencode-unguarded",
  "collector.ts",
  "install.sh",
  "libexec/opencode",
  "model-stub.ts",
  "telemetry-harness.sh",
  "uninstall.sh",
])

const OWNED_DIRECTORIES = new Set(["bin", "libexec"])


/** Whether a registration describes a service owned by this installation. */
function registrationBelongsToInstallation(
  registration: { readonly derivative?: string; readonly derivativeRevision?: string; readonly installation?: string },
  ownership: Ownership,
) {
  if (registration.derivative !== UNGUARDED_IDENTITY.name) return false
  if (registration.derivativeRevision !== UNGUARDED_IDENTITY.revision) return false
  // The installation identifier is required: a registration that predates it
  // cannot prove which installation owns the service, so it is refused rather
  // than matched approximately.
  if (ownership.installationId === undefined) return false
  return registration.installation === ownership.installationId
}

/**
 * Read a registration through the same validated contract the clients use, so
 * a record this handler accepts is never one Service.stop would treat as absent.
 * A present-but-unreadable record is invalid, not absent: removal then stops.
 */
const readRegistration = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(file)
    if (!exists) return { _tag: "absent" } as const
    const text = yield* fs.readFileString(file).pipe(Effect.option)
    if (Option.isNone(text)) return { _tag: "invalid" } as const
    return parseRegistration(text.value)
  })

/**
 * Entries under the installation root that an installation does not own.
 *
 * This is a read-only inventory: it never follows a symlink, and it reports
 * anything outside the packaged layout so removal can refuse before deleting.
 * A durable profile directory (`data`, `config`, ...) is unexpected here for
 * the same reason: removing it would destroy user data.
 */
const unexpectedEntries = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const unexpected: string[] = []
    const walk = (directory: string, prefix: string): Effect.Effect<void, never, never> =>
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[]))
        for (const name of names) {
          const relative = prefix === "" ? name : `${prefix}/${name}`
          const full = path.join(directory, name)
          const link = yield* fs.readLink(full).pipe(Effect.option)
          if (Option.isSome(link)) {
            unexpected.push(relative)
            continue
          }
          const stat = yield* fs.stat(full).pipe(Effect.option)
          if (Option.isNone(stat)) {
            unexpected.push(relative)
            continue
          }
          if (stat.value.type === "Directory") {
            if (prefix === "" && !OWNED_DIRECTORIES.has(name)) {
              unexpected.push(relative + "/")
              continue
            }
            yield* walk(full, relative)
            continue
          }
          if (!OWNED_FILES.has(relative)) unexpected.push(relative)
        }
      })
    yield* walk(root, "")
    return unexpected
  })

/** SHA-256 of a file, or a failure when it cannot be read. */
const sha256File = (fs: FileSystem.FileSystem, file: string) =>
  Effect.gen(function* () {
    const bytes = yield* fs.readFile(file)
    return createHash("sha256").update(bytes).digest("hex")
  })

/** Whether `target` is `root` or below it. */
function isInside(target: string, root: string) {
  return target === root || target.startsWith(root + path.sep)
}

// Remove only a command link that still points at this installation's launcher.
const findCommandLink = (fs: FileSystem.FileSystem, launcher: string, home: string) =>
  Effect.gen(function* () {
    const directory = path.join(home, ".local", "bin")
    const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => [] as string[]))
    for (const name of names) {
      if (name !== "opencode-unguarded") continue
      const link = path.join(directory, name)
      const target = yield* fs.readLink(link).pipe(Effect.orElseSucceed(() => undefined))
      if (target === undefined) continue
      if (path.resolve(directory, target) === launcher) return link
    }
    return undefined
  })
