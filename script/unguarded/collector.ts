#!/usr/bin/env bun

/**
 * OTLP collector harness with a positive control.
 *
 * The collector records request paths and flushes its result on termination.
 * A stock upstream binary must produce telemetry through the same harness; the
 * candidate binary must produce none. Without the positive control, an empty
 * result proves only that nothing was sent, not that the harness could observe.
 */

import fs from "node:fs"

const portFile = process.env.COLLECTOR_PORT_FILE ?? "/tmp/unguarded-collector.port"
const hitsFile = process.env.COLLECTOR_HITS_FILE ?? "/tmp/unguarded-collector.hits"
const duration = Number(process.env.COLLECTOR_DURATION_MS ?? 25_000)

const hits: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    hits.push(url.pathname)
    // Drain the body so the exporter sees a complete response.
    await request.arrayBuffer()
    return Response.json({})
  },
})

fs.writeFileSync(portFile, String(server.port))

const finish = () => {
  fs.writeFileSync(hitsFile, JSON.stringify(hits))
  server.stop(true)
  process.exit(0)
}

process.on("SIGTERM", finish)
process.on("SIGINT", finish)
await Bun.sleep(duration)
finish()
