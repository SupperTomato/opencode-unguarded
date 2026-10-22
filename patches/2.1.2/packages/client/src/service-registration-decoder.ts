/**
 * The single validated contract for a local service registration.
 *
 * Both clients and the uninstall handler use this module, so a record one of
 * them accepts is never one another treats as absent. Parsing untrusted JSON
 * happens once, at this boundary, and yields a typed result instead of a cast.
 *
 * Kept free of Effect so the Promise client does not load the Effect runtime.
 */

import type { Info } from "./service.js"

/** Outcome of reading a registration file. */
export type RegistrationRead =
  /** No file exists: there is no registered service. */
  | { readonly _tag: "absent" }
  /** A file exists but is not a usable registration. */
  | { readonly _tag: "invalid"; readonly reason: string }
  | { readonly _tag: "valid"; readonly info: Info }

const STRING_FIELDS = [
  "id",
  "version",
  "derivative",
  "derivativeRevision",
  "installation",
  "startTime",
  "password",
] as const

/**
 * Validate decoded JSON as a registration.
 *
 * `url` and `pid` are required; identity fields are optional so stock records
 * still decode, but their absence can never satisfy a derivative ownership
 * check. A present field with the wrong type makes the record invalid rather
 * than silently ignored, because "present but unusable" is not "absent".
 */
export function decodeRegistration(input: unknown): RegistrationRead {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { _tag: "invalid", reason: "not a JSON object" }
  const record = input as Record<string, unknown>
  if (typeof record.url !== "string" || record.url.length === 0)
    return { _tag: "invalid", reason: "missing or invalid url" }
  if (!isUrl(record.url)) return { _tag: "invalid", reason: "url is not an absolute http(s) URL" }
  if (typeof record.pid !== "number" || !Number.isInteger(record.pid) || record.pid <= 0)
    return { _tag: "invalid", reason: "missing or invalid pid" }
  for (const field of STRING_FIELDS) {
    const value = record[field]
    if (value !== undefined && typeof value !== "string")
      return { _tag: "invalid", reason: `${field} is not a string` }
  }
  const optional = Object.fromEntries(
    STRING_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]),
  )
  return { _tag: "valid", info: { url: record.url, pid: record.pid, ...optional } as Info }
}

/** Parse registration text. Malformed JSON is an invalid record, not an absent one. */
export function parseRegistration(text: string): RegistrationRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { _tag: "invalid", reason: "malformed JSON" }
  }
  return decodeRegistration(parsed)
}

function isUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}
