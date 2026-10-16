import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { listCodexSessions } from "../src/adapters/codex/list.ts"

const UUID_A = "aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb"
const UUID_C = "cccccccc-3333-3333-3333-cccccccccccc"
const UUID_D = "dddddddd-4444-4444-4444-dddddddddddd"
const UUID_E = "eeeeeeee-5555-5555-5555-eeeeeeeeeeee"

const rollout = (uuid: string, body: string): string =>
  `rollout-2026-01-02T03-04-05-${uuid}.jsonl${body}`

const metaLine = (cwd: string): string =>
  JSON.stringify({ type: "session_meta", timestamp: "2026-01-02T03:04:05Z", payload: { id: "x", cwd } })

const userLine = (text: string): string =>
  JSON.stringify({
    type: "response_item",
    timestamp: "2026-01-02T03:04:06Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  })

const seedHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "resume-codex-list-"))
  const sessions = join(home, "sessions", "2026", "01", "02")
  mkdirSync(sessions, { recursive: true })
  mkdirSync(join(home, "archived_sessions"), { recursive: true })
  mkdirSync(join(home, "workspaces", "fake"), { recursive: true })

  // mtime order (seconds ago): D oldest … A newest; E newest but excluded.
  const files: Array<[string, string, number]> = [
    [join(home, rollout(UUID_D, "")), `${metaLine("/tmp/d")}\n${userLine("top-level rollout")}\n`, 400],
    [join(home, "archived_sessions", rollout(UUID_C, "")), `${metaLine("/tmp/c")}\n${userLine("archived rollout")}\n`, 300],
    [join(sessions, rollout(UUID_B, ".zst")), "dummy-bytes-never-decompressed-by-list", 200],
    [join(sessions, rollout(UUID_A, "")), `${metaLine("/tmp/a")}\n${userLine("newest plain rollout")}\n`, 100],
    [join(home, "workspaces", "fake", rollout(UUID_E, "")), `${metaLine("/tmp/e")}\n`, 50],
  ]
  for (const [path, body, ageSec] of files) {
    writeFileSync(path, body)
    const atime = new Date(Date.now() - ageSec * 1000)
    utimesSync(path, atime, atime)
  }
  return home
}

const runList = (home: string, opts?: { cwd?: string }) => {
  process.env.CODEX_HOME = home
  return Effect.runPromise(
    listCodexSessions(opts ?? {}).pipe(Effect.provide(NodeServices.layer)),
  )
}

describe("codex list (scoped discovery)", () => {
  it("lists sessions/, archived_sessions/, and top-level rollouts — never workspaces/", async () => {
    const refs = await runList(seedHome())
    const ids = refs.map((r) => r.sessionId)
    assert.ok(ids.includes(UUID_A), "sessions/ plain")
    assert.ok(ids.includes(UUID_B), ".zst included")
    assert.ok(ids.includes(UUID_C), "archived_sessions/")
    assert.ok(ids.includes(UUID_D), "top-level legacy")
    assert.ok(!ids.includes(UUID_E), "workspaces/ must not be walked")
    // newest-first by mtime: A(400) > B(300) > C(200) > D(100); E excluded
    assert.deepEqual(ids, [UUID_A, UUID_B, UUID_C, UUID_D])
  })

  it("gives .zst rollouts stat-only refs without trying to read titles", async () => {
    const refs = await runList(seedHome())
    const zst = refs.find((r) => r.sessionId === UUID_B)
    assert.ok(zst, "zst ref present")
    assert.equal(zst.title, undefined)
    assert.ok(zst.path.endsWith(".zst"))
    const plain = refs.find((r) => r.sessionId === UUID_A)
    assert.equal(plain?.title, "newest plain rollout")
  })

  it("filters by rollout cwd without opening unrelated trees", async () => {
    const refs = await runList(seedHome(), { cwd: "/tmp/c" })
    // .zst rollouts have no readable header, so their cwd is unknown and
    // they are retained; only known-different cwds are excluded.
    assert.deepEqual(
      refs.map((r) => r.sessionId),
      [UUID_B, UUID_C],
    )
  })
})
