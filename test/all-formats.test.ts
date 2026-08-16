import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeClaudeFile } from "../src/adapters/claude/decode.ts"
import { decodeCodexFile } from "../src/adapters/codex/decode.ts"
import { decodeCursorStore } from "../src/adapters/cursor/decode.ts"
import { decodeGrokSession } from "../src/adapters/grok/decode.ts"
import { decodeOpenCodeSession } from "../src/adapters/opencode/decode.ts"
import { decodePiSession } from "../src/adapters/pi/decode.ts"
import { allAdapters } from "../src/adapters/index.ts"
import { encodeHandoffPackJson, toHandoffPack } from "../src/core/handoff.ts"
import { sanitizeSession } from "../src/core/safety.ts"
import type { Session } from "../src/ir/session.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const fixtures = join(root, "fixtures")

const run = <A, E>(effect: Effect.Effect<A, E, never | NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const assertHandoff = async (session: Session, expectedUserSnippet: RegExp) => {
  const safe = sanitizeSession(session)
  assert.ok(
    !safe.turns.some(
      (t) =>
        t._tag === "User" &&
        (t.text.includes("permissions instructions") ||
          t.text.includes("You are Grok") ||
          t.text.includes("You are Cursor") ||
          t.text.includes("<system-reminder") ||
          t.text.includes("<user_info>")),
    ),
    "instruction/system wrappers must not appear as user turns after sanitize",
  )
  const pack = toHandoffPack(safe)
  assert.match(pack.lastUserRequest ?? "", expectedUserSnippet)
  assert.ok(pack.safetyNote.toLowerCase().includes("untrusted"))
  assert.ok(pack.turnCount >= 1)
  const json = await run(encodeHandoffPackJson(pack))
  assert.match(json, expectedUserSnippet)
  assert.match(json, /"safetyNote"/)
  return { safe, pack, json }
}

describe("capabilities matrix", () => {
  it("lists all six formats with truthful list/decode/handoff", () => {
    const ids = allAdapters.map((a) => a.id).sort()
    assert.deepEqual(ids, ["claude", "codex", "cursor", "grok", "opencode", "pi"])
    for (const adapter of allAdapters) {
      assert.equal(adapter.capabilities.list, true, `${adapter.id} list`)
      assert.equal(adapter.capabilities.decode, true, `${adapter.id} decode`)
      assert.equal(adapter.capabilities.handoff, true, `${adapter.id} handoff`)
      assert.equal(adapter.capabilities.fidelity.list, "L0")
      assert.equal(adapter.capabilities.fidelity.decode, "L1")
      assert.equal(adapter.capabilities.fidelity.handoff, "L2")
      assert.equal(adapter.capabilities.transplant, false)
    }
  })
})

describe("codex fixture", () => {
  it("decode → sanitize → handoff recovers user text and tools", async () => {
    const path = join(fixtures, "codex/sample.jsonl")
    const session = await run(decodeCodexFile(path))
    assert.equal(session.source.format, "codex")
    assert.ok(session.turns.some((t) => t._tag === "Assistant" && t.toolCalls.some((c) => c.name === "local_shell")))
    assert.ok(session.warnings.some((w) => w.code === "malformed_records_skipped"))
    await assertHandoff(session, /flaky test/)
  })
})

describe("claude fixture", () => {
  it("decode → sanitize → handoff recovers user text and tools", async () => {
    const path = join(fixtures, "claude/sample.jsonl")
    const session = await run(decodeClaudeFile(path))
    assert.equal(session.source.format, "claude")
    assert.equal(session.meta.cwd, "/tmp/claude-demo")
    assert.ok(session.turns.some((t) => t._tag === "Assistant" && t.toolCalls.some((c) => c.name === "Bash")))
    assert.ok(
      !session.turns.some((t) => t._tag === "Assistant" && t.text?.includes("secret thoughts")),
    )
    // Parent chain walks through attachment/progress intermediate nodes (uuids att1/prog1)
    // and still reaches early + late user turns.
    const userTexts = session.turns
      .filter((t) => t._tag === "User")
      .map((t) => (t._tag === "User" ? t.text : ""))
    assert.ok(
      userTexts.some((t) => /refactor the auth module/.test(t)),
      `expected early user turn in chain, got: ${JSON.stringify(userTexts)}`,
    )
    assert.ok(
      userTexts.some((t) => /rate limiting/.test(t)),
      `expected late user turn after attachment mid-chain, got: ${JSON.stringify(userTexts)}`,
    )
    const { pack } = await assertHandoff(session, /rate limiting/)
    assert.match(pack.lastUserRequest ?? "", /rate limiting/)
  })
})

describe("grok fixture", () => {
  it("decode → sanitize → handoff extracts user_query and drops wrappers", async () => {
    const path = join(fixtures, "grok/session")
    const session = await run(decodeGrokSession(path))
    assert.equal(session.source.format, "grok")
    assert.equal(session.meta.cwd, "/tmp/grok-demo")
    const userTurns = session.turns.filter((t) => t._tag === "User")
    assert.ok(userTurns.every((t) => t._tag === "User" && !t.text.includes("system-reminder")))
    await assertHandoff(session, /print hello from grok fixture/)
  })
})

describe("cursor fixture", () => {
  it("decode → sanitize → handoff recovers user_query and tools", async () => {
    const path = join(fixtures, "cursor/store.db")
    const session = await run(decodeCursorStore(path))
    assert.equal(session.source.format, "cursor")
    assert.ok(session.turns.some((t) => t._tag === "Assistant" && t.toolCalls.length > 0))
    await assertHandoff(session, /ship cursor fixture handoff/)
  })

  it("strips plain USER: prefix from raw cursor blobs", async () => {
    // Drive the real decoder path with a store that only has a plain USER: blob
    const { DatabaseSync } = await import("node:sqlite")
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const dir = mkdtempSync(join(tmpdir(), "resume-cursor-plain-"))
    const store = join(dir, "store.db")
    const db = new DatabaseSync(store)
    db.exec(`CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`)
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(
      "0",
      JSON.stringify({ agentId: "plain-user", name: "plain" }),
    )
    db.prepare("INSERT INTO blobs(id,data) VALUES(?,?)").run(
      "u1",
      " USER: Say hello$44c6fb09-29ee-4962-832d-55865f532002",
    )
    db.prepare("INSERT INTO blobs(id,data) VALUES(?,?)").run(
      "a1",
      JSON.stringify({ role: "assistant", content: "Hello there." }),
    )
    db.close()

    const session = await run(decodeCursorStore(store))
    const userTurns = session.turns.filter((t) => t._tag === "User")
    assert.equal(userTurns.length, 1)
    assert.equal(userTurns[0]?._tag === "User" ? userTurns[0].text : "", "Say hello")
    const { pack } = await assertHandoff(session, /^Say hello$|Say hello/)
    assert.equal(pack.lastUserRequest, "Say hello")
    assert.ok(!pack.lastUserRequest?.startsWith("USER:"))
  })
})

describe("opencode fixture", () => {
  it("decode → sanitize → handoff recovers user text and tools", async () => {
    const path = join(fixtures, "opencode/opencode.db")
    const session = await run(decodeOpenCodeSession(path, "ses_fixture_opencode_1"))
    assert.equal(session.source.format, "opencode")
    assert.equal(session.meta.cwd, "/tmp/opencode-demo")
    assert.ok(session.turns.some((t) => t._tag === "Assistant" && t.toolCalls.some((c) => c.name === "bash")))
    await assertHandoff(session, /deploy the staging pipeline/)
  })
})

describe("pi fixture", () => {
  it("decode → sanitize → handoff recovers user text and tools", async () => {
    const path = join(fixtures, "pi/crush.db")
    const session = await run(decodePiSession(path, "pi-fixture-session-1"))
    assert.equal(session.source.format, "pi")
    assert.ok(session.turns.some((t) => t._tag === "Assistant" && t.toolCalls.some((c) => c.name === "read")))
    await assertHandoff(session, /setup pi fixture agent/)
  })
})
