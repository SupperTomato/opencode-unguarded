/**
 * Deterministic, offline model for the telemetry harness.
 *
 * The harness must exercise a real session, because "the candidate emitted no
 * telemetry" only means something for code paths that actually run. Depending
 * on a live provider would make the check flaky and network-dependent, so this
 * stub speaks the OpenAI-compatible chat protocol the openai-compatible
 * provider expects.
 *
 * It makes the session do real work: the first request asks the model to call
 * the `read` tool on a known file, and the second request (which carries the
 * tool result) answers with the file's contents. A harness that never executes
 * a tool therefore cannot pass.
 */

const FILE = "harness-target.txt"
const CONTENTS = "harness tool output"
const CALL_ID = "call_harness_1"

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/chat/completions")) {
      const body = (await request.json().catch(() => ({}))) as {
        stream?: boolean
        messages?: ReadonlyArray<{ role?: string; content?: unknown }>
      }
      const sawToolResult = (body.messages ?? []).some((message) => message.role === "tool")
      const message = sawToolResult
        ? { role: "assistant", content: `tool returned: ${CONTENTS}` }
        : {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: CALL_ID,
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: FILE }) },
              },
            ],
          }
      const finish = sawToolResult ? "stop" : "tool_calls"
      if (body.stream === true) {
        const delta = sawToolResult
          ? { role: "assistant", content: message.content }
          : {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: CALL_ID,
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: FILE }) },
                },
              ],
            }
        const chunk = {
          id: "harness",
          object: "chat.completion.chunk",
          created: 1,
          model: "stub",
          choices: [{ index: 0, delta, finish_reason: null }],
        }
        const done = {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }
        return new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return Response.json({
        id: "harness",
        object: "chat.completion",
        created: 1,
        model: "stub",
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    }
    if (url.pathname.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "stub", object: "model", created: 1, owned_by: "harness" }] })
    }
    return new Response(null, { status: 404 })
  },
})

const portFile = process.env.PORTFILE
if (portFile === undefined) throw new Error("PORTFILE is required")
await Bun.write(portFile, String(server.port))

process.on("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
await new Promise(() => {})
