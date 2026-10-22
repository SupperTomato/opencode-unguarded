/**
 * Redact credential-bearing command arguments before logging.
 *
 * The CLI records its startup and failure arguments to diagnose a failed run.
 * Some commands carry secrets on the command line: `service set password`,
 * `service set env <KEY> <VALUE>`, `auth login --answer <key>=<value>`, and the
 * generic `--password`/`--token`/`--api-key` flags. Those values must never
 * reach the log file, which is retained and may be exported for support.
 *
 * This is deliberately conservative: an argument following a sensitive flag, or
 * the value operand of a sensitive command, is replaced wholesale. Over-redacting
 * a non-secret argument is harmless; logging a secret is not.
 */

// Flags whose following argument is a secret.
const SECRET_FLAGS = new Set([
  "--password",
  "--token",
  "--api-key",
  "--apikey",
  "--secret",
  "--client-secret",
  "--authorization",
])

const REDACTED = "<redacted>"

/** Commands whose positional operands include a secret value. */
const SECRET_COMMANDS: ReadonlyArray<{
  readonly prefix: ReadonlyArray<string>
  /** Operand indexes (after the command words) that are safe to log. */
  readonly visible: ReadonlyArray<number>
}> = [
  // opencode service set password <value>
  { prefix: ["service", "set", "password"], visible: [] },
  // opencode service set env <KEY> <VALUE>: the key is safe, the value is not.
  { prefix: ["service", "set", "env"], visible: [0] },
  // opencode auth login <integration> --answer <key>=<value>
  { prefix: ["auth", "login"], visible: [0] },
]

/** Return a loggable copy of CLI arguments, preserving the command structure. */
export function redactArguments(args: ReadonlyArray<string>): string[] {
  const command = commandWords(args)
  // The command words must stop at the matched command, not run to the end of
  // the leading non-flag arguments, or the secret value would become part of the
  // command name and escape the operand rules.
  const rule = SECRET_COMMANDS.find((entry) => startsWith(command, entry.prefix))
  const commandEnd = rule?.prefix.length ?? command.length
  const operand = operandIndexes(args, commandEnd)
  const secretOperands = new Set(
    rule === undefined
      ? []
      : operand.filter((index) => !rule.visible.includes(operand.indexOf(index))),
  )

  const output: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const flag = [...SECRET_FLAGS].find((name) => arg === name)
    if (flag !== undefined) {
      output.push(arg)
      // The following argument belongs to this flag.
      if (index + 1 < args.length) output.push(REDACTED)
      index++
      continue
    }
    const inline = [...SECRET_FLAGS].find((name) => arg.startsWith(`${name}=`))
    if (inline !== undefined) {
      output.push(`${inline}=${REDACTED}`)
      continue
    }
    if (arg === "--answer") {
      output.push(arg)
      if (index + 1 < args.length) output.push(redactAnswer(args[index + 1]!))
      index++
      continue
    }
    if (arg.startsWith("--answer=")) {
      output.push(`--answer=${redactAnswer(arg.slice("--answer=".length))}`)
      continue
    }
    output.push(secretOperands.has(index) ? REDACTED : arg)
  }
  return output
}

/** Keep the answer's key so the diagnostic still says which field failed. */
function redactAnswer(value: string) {
  const separator = value.indexOf("=")
  return separator < 1 ? REDACTED : `${value.slice(0, separator)}=${REDACTED}`
}

/** The leading non-flag arguments that name the command. */
function commandWords(args: ReadonlyArray<string>) {
  const words: string[] = []
  for (const arg of args) {
    if (arg.startsWith("-")) break
    words.push(arg)
  }
  return words
}

function startsWith(value: ReadonlyArray<string>, prefix: ReadonlyArray<string>) {
  return prefix.every((part, index) => value[index] === part)
}

/**
 * Indexes of positional operands after the command words, skipping the value of
 * a sensitive flag so a redacted flag value is never treated as an operand.
 */
function operandIndexes(args: ReadonlyArray<string>, start: number) {
  const indexes: number[] = []
  for (let index = start; index < args.length; index++) {
    const arg = args[index]!
    if (arg.startsWith("-")) continue
    if (index > 0 && SECRET_FLAGS.has(args[index - 1]!)) continue
    indexes.push(index)
  }
  return indexes
}

/**
 * Whether this invocation is the read-only preview of an operation.
 *
 * The Global layer and the logger are selected during bootstrap, before the CLI
 * parser runs, so they need a small argv reader of their own. It must identify
 * the *operation*, not merely the presence of the flag: `opencode run "explain
 * --dry-run"` is not a dry run and must keep normal logging.
 */
export function isReadOnlyInvocation(args: ReadonlyArray<string>) {
  const words: string[] = []
  for (const arg of args) {
    if (arg.startsWith("-")) break
    words.push(arg)
  }
  return words[0] === "uninstall" && args.includes("--dry-run")
}
