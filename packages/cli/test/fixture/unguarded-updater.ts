import { Effect, Layer, Stream } from "effect"
import { NodeServices } from "@effect/platform-node"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Updater } from "../../src/services/updater"

const record = (event: unknown) => console.log(`EVENT ${JSON.stringify(event)}`)
const root = process.env.UPDATER_FIXTURE_ROOT!

const global = Global.make({
  home: root,
  data: `${root}/data`,
  cache: `${root}/cache`,
  config: `${root}/config`,
  state: `${root}/state`,
  tmp: `${root}/tmp`,
  bin: `${root}/bin`,
  log: `${root}/log`,
  repos: `${root}/repos`,
})

const updater = await Effect.runPromise(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* Updater.Service.pipe(
      Effect.provide(Updater.layer),
      Effect.provide(
        LayerNode.compile(EffectFlock.node, {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(
        AppProcess.Service,
        AppProcess.Service.of({
          ...spawner,
          run: (command: ChildProcess.Command) => {
            if (command._tag !== "StandardCommand") return Effect.die("unexpected piped command")
            record({ spawn: [command.command, ...command.args] })
            return Effect.succeed({
              command: command.command,
              exitCode: 0,
              stdout: Buffer.alloc(0),
              stderr: Buffer.alloc(0),
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          },
          runStream: () => Stream.die("unexpected streaming command"),
        }),
      ),
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped, Effect.provideService(Global.Service, global)),
)

const attempt = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error) => record({ label, failed: true, message: String((error as Error)?.message ?? error) }),
        onSuccess: (value) => record({ label, failed: false, value: value === undefined ? "undefined" : value }),
      }),
    ),
  )

for (const method of ["curl", "npm", "pnpm", "bun", "yarn", "vp", "brew", "winget"] as const) {
  await attempt(`upgrade:${method}`, updater.upgrade(method, "2.1.2"))
}
await attempt("latest", updater.latest())
await attempt("run", updater.run())
await attempt("check", updater.check())
await attempt("apply", updater.apply("2.1.3"))
record({ removal: updater.removal("npm") === undefined ? "undefined" : "defined" })
record({ removalCurl: updater.removal("curl") === undefined ? "undefined" : "defined" })
