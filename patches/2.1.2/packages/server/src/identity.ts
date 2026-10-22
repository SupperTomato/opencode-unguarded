export * as ServerIdentity from "./identity"

import { ProcessIdentity } from "@opencode/util/process-identity"
import type { ServerOptions } from "./options"

// Captured once: a process's start time is a property of its lifetime, not of
// an individual request or of how far the application has finished booting.
const startTime = ProcessIdentity.processStartTime()

/**
 * Identity fields a client needs to recognize the process answering.
 *
 * The early health responder serves requests before the application routes are
 * ready, so it must use this same projection: a client polling a slow or failed
 * startup has to be able to tell an owned service from a foreign one. Stock
 * builds leave the derivative fields unset, and clients treat that as "cannot
 * prove derivative ownership".
 */
export function identity(app: ServerOptions["app"] = {}) {
  return {
    ...(app.derivative === undefined ? {} : { derivative: app.derivative }),
    ...(app.derivativeRevision === undefined ? {} : { derivativeRevision: app.derivativeRevision }),
    ...(app.installation === undefined ? {} : { installation: app.installation }),
    ...(startTime === undefined ? {} : { startTime }),
  }
}
