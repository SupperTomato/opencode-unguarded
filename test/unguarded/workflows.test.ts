import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const repoRoot = process.env.UNGUARDED_SOURCE_ROOT ?? path.join(import.meta.dir, "..", "..")
const active = path.join(repoRoot, ".github/workflows")

describe("workflow inventory", () => {
  test("only derivative workflows are active", () => {
    expect(fs.readdirSync(active).sort()).toEqual(["build-release.yml", "check.yml", "discover-upstream.yml"])
  })

  test("disabled workflows are documented", () => {
    expect(fs.existsSync(path.join(repoRoot, ".github/workflows-disabled/README.md"))).toBe(true)
  })

  test("the build workflow validates input before using it", () => {
    const content = fs.readFileSync(path.join(active, "build-release.yml"), "utf8")
    expect(content).toContain('grep -Eq \'^[1-9][0-9]*$\'')
    expect(content).not.toContain("${{ inputs.derivative_revision }}\" \\")
  })

  test("the build workflow checks the manifest's exact changed files", () => {
    const content = fs.readFileSync(path.join(active, "build-release.yml"), "utf8")
    expect(content).toContain(".files[].file")
    expect(content).toContain("Protected file changed")
  })

  test("the build workflow requires a positive telemetry control", () => {
    const content = fs.readFileSync(path.join(active, "build-release.yml"), "utf8")
    expect(content).toContain("telemetry-harness.sh")
    expect(content).toContain("positive control")
  })

  test("discovery does not hardcode a derivative revision", () => {
    const content = fs.readFileSync(path.join(active, "discover-upstream.yml"), "utf8")
    expect(content).toContain("derivativeRevision")
    expect(content).not.toContain("unguarded.2")
  })
})
