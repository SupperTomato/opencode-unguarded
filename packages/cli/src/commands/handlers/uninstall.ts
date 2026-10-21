import { confirm, intro, log, outro, spinner } from "@clack/prompts"
import { Service } from "@opencode/client/effect/service"
import { Global } from "@opencode/util/global"
import { Effect, FileSystem, Schedule } from "effect"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { RetainedImage } from "../../services/retained-image"
import { Updater } from "../../services/updater"
import { handlePromptErrors, prompt, requireInteractive } from "../../ui/prompt"
import { errorMessage } from "../../util/error"
import { UNGUARDED, UNGUARDED_IDENTITY } from "../../version"

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

  // An installation that contains the profile cannot be removed without
  // deleting durable data. Refuse before listing or stopping anything.
  const rootReal = yield* fs.realPath(root)
  // global.data is <profile>/data/opencode.
  const profileRoot = yield* fs.realPath(path.dirname(path.dirname(global.data)))
  if (rootReal === profileRoot || rootReal.startsWith(profileRoot + path.sep) || profileRoot.startsWith(rootReal + path.sep))
    return yield* Effect.fail(
      new Error(
        `refusing to remove ${rootReal}: it overlaps the application profile (${profileRoot}). ` +
          `Move the profile with OPENCODE_UNGUARDED_PROFILE, then uninstall.`,
      ),
    )

  const registration = path.join(global.state, "service-unguarded.json")
  const stop = yield* readOwnedRegistration(fs, registration)
  const command = yield* findCommandLink(fs, launcher, global.home)

  log.message("Sessions, credentials, configuration, and other profile data are kept.")
  log.info(`  Installation: ${rootReal}`)
  log.info(`  Service registration: ${registration}`)
  if (stop) log.info(`  Background service: pid ${stop.pid}`)
  if (command) log.info(`  Command link: ${command}`)

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
    yield* ServerConnection.shutdownPersistentPty({ file: registration }).pipe(Effect.ignore)
    yield* Service.stop({ file: registration }).pipe(
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

// Only a registration written by this derivative may be signalled, and only
// while it still describes the same live instance.
const readOwnedRegistration = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(
    Effect.map((text) => JSON.parse(text) as { pid?: number; derivative?: string; version?: string; url?: string }),
    Effect.map((found) =>
      found.derivative === UNGUARDED_IDENTITY.name && Number.isInteger(found.pid) && (found.pid ?? 0) > 0
        ? { pid: found.pid! }
        : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  )

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
