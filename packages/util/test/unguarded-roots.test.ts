import { expect, test } from "bun:test"
import path from "node:path"

/**
 * The derivative must not fall back to stock application storage when the
 * binary is invoked directly instead of through its launcher.
 */
function run(source: string) {
  const root = path.join(import.meta.dir, "..")
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      "OPENCODE_UNGUARDED=true",
      "-e",
      `const { roots } = await import(${JSON.stringify(path.join(root, "src/global-roots.ts"))})
       console.log(JSON.stringify(roots("opencode")))`,
    ],
    {
      cwd: root,
      env: { ...process.env, OPENCODE_UNGUARDED_PROFILE: "/tmp/derivative-profile" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return {
    exitCode: child.exitCode,
    stderr: child.stderr.toString(),
    value: JSON.parse(child.stdout.toString() || "null") as Record<string, string> | null,
  }
}

test("derivative roots stay inside the profile", () => {
  const result = run("")
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" })
  expect(result.value).toEqual({
    data: "/tmp/derivative-profile/data/opencode",
    cache: "/tmp/derivative-profile/cache/opencode",
    config: "/tmp/derivative-profile/config/opencode",
    state: "/tmp/derivative-profile/state/opencode",
    tmp: "/tmp/derivative-profile/tmp/opencode",
  })
})

test("stock builds keep XDG roots", () => {
  const root = path.join(import.meta.dir, "..")
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--define",
      "OPENCODE_UNGUARDED=false",
      "-e",
      `const { roots } = await import(${JSON.stringify(path.join(root, "src/global-roots.ts"))})
       console.log(JSON.stringify(roots("opencode")))`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_DATA_HOME: "/tmp/xdg/data",
        XDG_CONFIG_HOME: "/tmp/xdg/config",
        XDG_CACHE_HOME: "/tmp/xdg/cache",
        XDG_STATE_HOME: "/tmp/xdg/state",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(child.stdout.toString())).toMatchObject({
    data: "/tmp/xdg/data/opencode",
    config: "/tmp/xdg/config/opencode",
    cache: "/tmp/xdg/cache/opencode",
    state: "/tmp/xdg/state/opencode",
  })
})
