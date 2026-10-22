export * as ServerControl from "./control"

import { Context, Effect, Layer } from "effect"

/**
 * In-process control surface for the managed daemon lifecycle.
 *
 * The identity fields let an authenticated request prove it is addressing this
 * exact service instance before asking it to stop. A caller that learned the
 * instance ID and process lifetime from `/api/info` cannot accidentally stop a
 * different process that later reused the same numeric PID.
 */
export interface Interface {
  /** Whether this process exposes the managed control surface. */
  readonly available: boolean
  /** Service instance identifier, matching the registration and `/api/info`. */
  readonly instanceId?: string
  /** Operating-system process start time, when the platform exposes one. */
  readonly startTime?: string
  /** Ask the daemon to shut down. Idempotent and safe to race. */
  readonly shutdown: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/server/Control") {}

export const layer = (value: Interface) => Layer.succeed(Service, Service.of(value))

/** Control surface for an embedded or unmanaged server: it cannot be asked to stop. */
export const disabled = layer({ available: false, shutdown: Effect.void })
