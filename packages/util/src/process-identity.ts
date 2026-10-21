import fs from "node:fs"

/**
 * Process start time from the operating system, or undefined when the platform
 * does not expose one.
 *
 * A PID identifies a process only until it exits; the same number can then be
 * reused. Pairing a PID with its start time lets a caller tell "the process I
 * registered" from "whatever now holds that number". Linux exposes the start
 * time in clock ticks since boot as field 22 of /proc/<pid>/stat. The `comm`
 * field can contain spaces and parentheses, so parsing starts after the last
 * `)`, which is what makes this reliable for arbitrary executable names.
 */
export function processStartTime(pid = process.pid): string | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    // After the comm field, index 0 is state (field 3), so field 22 is index 19.
    const ticks = fields[19]
    if (ticks === undefined) return undefined
    return `linux:${ticks}`
  } catch {
    return undefined
  }
}

export * as ProcessIdentity from "./process-identity.js"
