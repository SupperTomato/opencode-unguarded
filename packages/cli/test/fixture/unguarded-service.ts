import { NodeFileSystem } from "@effect/platform-node"
import { Effect } from "effect"
import { ServiceConfig } from "../../src/services/service-config"

const operation = process.argv[2]!
const record = (value: unknown) => console.log(`RESULT ${JSON.stringify(value)}`)
const fs = await import("node:fs/promises")

if (operation === "identity") {
  record({
    filename: ServiceConfig.filename(),
    port: ServiceConfig.defaultPort("unguarded", "linux"),
    channel: ServiceConfig.DERIVATIVE_CHANNEL,
  })
} else if (operation.startsWith("migrate:")) {
  const [, legacy, target] = operation.split(":")
  await Effect.runPromise(
    ServiceConfig.migrateRegistration(legacy!, target!, ServiceConfig.DERIVATIVE_CHANNEL, "2.1.2").pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  )
  const migrated = await fs.stat(target!).then(() => true, () => false)
  const legacyExists = await fs.stat(legacy!).then(() => true, () => false)
  record({ migrated, legacy: legacyExists })
}
