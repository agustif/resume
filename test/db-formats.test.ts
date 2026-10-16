import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeCursorStore } from "../src/adapters/cursor/decode.ts"
import { decodeGrokSession } from "../src/adapters/grok/decode.ts"
import { decodeOpenCodeSession } from "../src/adapters/opencode/decode.ts"
import { decodePiSession } from "../src/adapters/pi/decode.ts"
import { DecodeFailed } from "../src/core/errors.ts"
import { IR_VERSION } from "../src/ir/index.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const fixtures = join(root, "fixtures")

const run = <A, E>(effect: Effect.Effect<A, E, never | NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const asDecodeFailed = (value: unknown): DecodeFailed => {
  assert.ok(value instanceof DecodeFailed, `expected DecodeFailed, got ${JSON.stringify(value)}`)
  return value as DecodeFailed
}

const openTempDb = async (name: string, schema: string) => {
  const { DatabaseSync } = await import("node:sqlite")
  const dir = mkdtempSync(join(tmpdir(), `resume-${name}-`))
  const dbPath = join(dir, `${name}.db`)
  const db = new DatabaseSync(dbPath)
  db.exec(schema)
  return { db, dbPath }
}

describe("unknown session ids", () => {
  it("opencode fails instead of returning an empty session", async () => {
    const dbPath = join(fixtures, "opencode/opencode.db")
    const error = asDecodeFailed(await run(decodeOpenCodeSession(dbPath, "ses_does_not_exist").pipe(Effect.flip)))
    assert.equal(error._tag, "DecodeFailed")
    assert.equal(error.format, "opencode")
    assert.equal(error.path, dbPath)
    assert.equal(error.reason, "unknown session id: ses_does_not_exist")
  })

  it("pi fails instead of returning an empty session", async () => {
    const dbPath = join(fixtures, "pi/crush.db")
    const error = asDecodeFailed(await run(decodePiSession(dbPath, "nope").pipe(Effect.flip)))
    assert.equal(error._tag, "DecodeFailed")
    assert.equal(error.format, "pi")
    assert.equal(error.path, dbPath)
    assert.equal(error.reason, "unknown session id: nope")
  })
})

describe("row exists but has no messages", () => {
  it("opencode warns with opencode_empty_session", async () => {
    const { db, dbPath } = await openTempDb(
      "opencode-empty",
      `CREATE TABLE session (
         id TEXT PRIMARY KEY, directory TEXT, title TEXT,
         time_created INTEGER, time_updated INTEGER
       );
       CREATE TABLE message (
         id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
       );
       CREATE TABLE part (
         id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
         time_created INTEGER, data TEXT
       );`,
    )
    db.prepare("INSERT INTO session(id,directory,title,time_created,time_updated) VALUES(?,?,?,?,?)").run(
      "ses_empty_1",
      "/tmp/empty-demo",
      "empty session",
      1_700_000_000_000,
      1_700_000_000_000,
    )
    db.close()

    const session = await run(decodeOpenCodeSession(dbPath, "ses_empty_1"))
    assert.equal(session.turns.length, 0)
    assert.equal(session.meta.cwd, "/tmp/empty-demo")
    assert.ok(
      session.warnings.some((w) => w.code === "opencode_empty_session"),
      `expected opencode_empty_session warning, got ${JSON.stringify(session.warnings)}`,
    )
  })

  it("pi warns with pi_empty_session", async () => {
    const { db, dbPath } = await openTempDb(
      "pi-empty",
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER
       );
       CREATE TABLE messages (
         id TEXT PRIMARY KEY, session_id TEXT, role TEXT, parts TEXT, created_at INTEGER
       );`,
    )
    db.prepare("INSERT INTO sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(
      "pi-empty-1",
      "empty pi session",
      1_700_000_000,
      1_700_000_000,
    )
    db.close()

    const session = await run(decodePiSession(dbPath, "pi-empty-1"))
    assert.equal(session.turns.length, 0)
    assert.equal(session.meta.title, "empty pi session")
    assert.ok(
      session.warnings.some((w) => w.code === "pi_empty_session"),
      `expected pi_empty_session warning, got ${JSON.stringify(session.warnings)}`,
    )
  })
})

describe("grok timestamps", () => {
  it("backfills createdAt/updatedAt from chat_history.jsonl mtime", async () => {
    const dir = join(fixtures, "grok/session")
    const expected = statSync(join(dir, "chat_history.jsonl")).mtime.toISOString()
    const session = await run(decodeGrokSession(dir))
    assert.equal(session.meta.createdAt, expected)
    assert.equal(session.meta.updatedAt, expected)
  })
})

describe("canonical tool mapping", () => {
  it("tags opencode and pi tool calls with their canonical family", async () => {
    const opencode = await run(
      decodeOpenCodeSession(join(fixtures, "opencode/opencode.db"), "ses_fixture_opencode_1"),
    )
    const bash = opencode.turns
      .flatMap((t) => (t._tag === "Assistant" ? t.toolCalls : []))
      .find((c) => c.name === "bash")
    assert.equal(bash?.canonical, "shell")

    const pi = await run(decodePiSession(join(fixtures, "pi/crush.db"), "pi-fixture-session-1"))
    const read = pi.turns
      .flatMap((t) => (t._tag === "Assistant" ? t.toolCalls : []))
      .find((c) => c.name === "read")
    assert.equal(read?.canonical, "read")
  })

  it("every session reports the shared IR_VERSION", async () => {
    const session = await run(
      decodeOpenCodeSession(join(fixtures, "opencode/opencode.db"), "ses_fixture_opencode_1"),
    )
    assert.equal(session.irVersion, IR_VERSION)
  })
})

describe("cursor json array blobs", () => {
  it("renders every record element of an array blob", async () => {
    const { DatabaseSync } = await import("node:sqlite")
    const dir = mkdtempSync(join(tmpdir(), "resume-cursor-array-"))
    const sessionDir = join(dir, "array-session")
    mkdirSync(sessionDir)
    const store = join(sessionDir, "store.db")
    const db = new DatabaseSync(store)
    db.exec(`CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);`)
    db.prepare("INSERT INTO meta(key,value) VALUES(?,?)").run(
      "0",
      JSON.stringify({ agentId: "array-blob", name: "array title" }),
    )
    db.prepare("INSERT INTO blobs(id,data) VALUES(?,?)").run(
      "arr1",
      JSON.stringify([
        { role: "user", content: "ship the array blob" },
        {
          role: "assistant",
          content: "on it",
          tool_calls: [{ id: "c1", function: { name: "bash", arguments: { cmd: "ls" } } }],
        },
      ]),
    )
    db.close()

    const session = await run(decodeCursorStore(store))
    const users = session.turns.filter((t) => t._tag === "User")
    assert.equal(users.length, 1)
    assert.equal(users[0]?._tag === "User" ? users[0].text : "", "ship the array blob")
    const assistant = session.turns.find((t) => t._tag === "Assistant")
    assert.ok(assistant && assistant._tag === "Assistant" && assistant.toolCalls.length === 1)
    assert.equal(assistant._tag === "Assistant" ? assistant.toolCalls[0]?.canonical : "", "shell")
    assert.equal(session.meta.title, "array title")
    assert.ok(!session.warnings.some((w) => w.code === "cursor_limited_blob_parse"))

    const expected = statSync(store).mtime.toISOString()
    assert.equal(session.meta.createdAt, expected)
    assert.equal(session.meta.updatedAt, expected)
  })
})
