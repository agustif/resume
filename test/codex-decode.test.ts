import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeCodexFile } from "../src/adapters/codex/decode.ts"
import { encodeHandoffPackJson, toHandoffPack } from "../src/core/handoff.ts"
import { sanitizeSession } from "../src/core/safety.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures")

const run = (path: string, maxToolChars = 300) =>
  Effect.runPromise(
    decodeCodexFile(path, maxToolChars).pipe(Effect.provide(NodeServices.layer)),
  )

const writeRollout = (lines: Array<unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), "resume-codex-"))
  const path = join(
    dir,
    "rollout-2026-02-03T04-05-06-12345678-1234-1234-1234-123456789abc.jsonl",
  )
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"))
  return path
}

const meta = { type: "session_meta", timestamp: "2026-02-03T04:05:06Z", payload: { id: "s1", cwd: "/tmp/x" } }
const userMsg = (text: string) => ({
  type: "response_item",
  timestamp: "2026-02-03T04:05:07Z",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
})

describe("codex decode (legacy path)", () => {
  it("decodes committed fixture rollout into IR and handoff pack", async () => {
    const path = join(fixtures, "codex/sample.jsonl")
    const session = await Effect.runPromise(
      decodeCodexFile(path).pipe(Effect.provide(NodeServices.layer)),
    )

    assert.equal(session.source.format, "codex")
    assert.equal(session.meta.cwd, "/tmp/demo")
    assert.equal(session.meta.branch, "main")
    assert.ok(session.turns.some((t) => t._tag === "User"))
    assert.ok(session.turns.some((t) => t._tag === "Assistant"))
    assert.ok(
      !session.turns.some(
        (t) => t._tag === "User" && t.text.includes("permissions instructions"),
      ),
    )

    const safe = sanitizeSession(session)
    const pack = toHandoffPack(safe)
    assert.match(pack.lastUserRequest ?? "", /flaky test/)
    assert.ok(pack.turnCount >= 2)

    const json = await Effect.runPromise(encodeHandoffPackJson(pack))
    assert.match(json, /"format": "codex"/)
    assert.match(json, /flaky test/)
  })
})

describe("codex decode (agentic wire)", () => {
  it("marks compaction and rollback with Boundary turns", async () => {
    const path = writeRollout([
      meta,
      {
        type: "compacted",
        timestamp: "2026-02-03T04:05:08Z",
        payload: { replacement_history: [userMsg("early hello").payload] },
      },
      userMsg("late hello"),
      { type: "event_msg", timestamp: "2026-02-03T04:05:09Z", payload: { type: "thread_rolled_back", num_turns: 1 } },
    ])
    const session = await run(path)
    const boundaries = session.turns.filter((t) => t._tag === "Boundary")
    assert.ok(boundaries.some((t) => t._tag === "Boundary" && t.kind === "compact"))
    assert.ok(boundaries.some((t) => t._tag === "Boundary" && t.kind === "rollback"))
    const users = session.turns.filter((t) => t._tag === "User")
    assert.ok(users.some((t) => t._tag === "User" && t.text === "early hello"))
  })

  it("routes agent traffic into subagent runs and shell executions into tool turns", async () => {
    const path = writeRollout([
      meta,
      userMsg("deploy it"),
      {
        type: "response_item",
        timestamp: "2026-02-03T04:05:08Z",
        payload: {
          type: "agent_message",
          id: "amsg1",
          author: "/root",
          recipient: "/root/worker",
          content: [{ type: "input_text", text: "NEW_TASK do the deploy" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-03T04:05:09Z",
        payload: {
          type: "item_completed",
          turn_id: "t1",
          item: {
            type: "CommandExecution",
            id: "exec1",
            command: ["git", "status"],
            stdout: "clean",
            exit_code: 0,
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-03T04:05:10Z",
        payload: {
          type: "item_completed",
          turn_id: "t1",
          item: {
            type: "AgentMessage",
            id: "m1",
            content: [{ type: "Text", text: "deployed ok" }],
          },
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-03T04:05:11Z",
        payload: { type: "task_complete", turn_id: "t1", last_agent_message: "all done" },
      },
    ])
    const session = await run(path)
    assert.equal(session.subagents?.length, 1)
    const sub = session.subagents?.[0]
    assert.equal(sub?.id, "/root/worker")
    assert.ok(sub?.turns.some((t) => t._tag === "Assistant" && (t.text ?? "").includes("NEW_TASK")))
    assert.ok(sub?.turns.some((t) => t._tag === "Assistant" && t.text === "deployed ok"))
    const shellCalls = session.turns.flatMap((t) => (t._tag === "Assistant" ? t.toolCalls : []))
    assert.ok(shellCalls.some((c) => c.name === "shell" && c.canonical === "shell"))
    assert.ok(
      session.turns.some(
        (t) =>
          t._tag === "ToolResult" &&
          t.results.some((r) => r.content === "clean" && r.isError === false),
      ),
    )
    assert.ok(
      session.turns.some((t) => t._tag === "Assistant" && t.text === "all done"),
    )
  })

  it("dedupes task_complete against the same assistant text and ignores progress noise", async () => {
    const path = writeRollout([
      meta,
      {
        type: "response_item",
        timestamp: "2026-02-03T04:05:08Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "same answer" }] },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-03T04:05:09Z",
        payload: { type: "task_complete", turn_id: "t1", last_agent_message: "same answer" },
      },
      { type: "token_usage_record", timestamp: "2026-02-03T04:05:10Z", payload: {} },
      { type: "event_msg", timestamp: "2026-02-03T04:05:11Z", payload: { type: "task_started", turn_id: "t1" } },
      { type: "turn_context", timestamp: "2026-02-03T04:05:12Z", payload: {} },
    ])
    const session = await run(path)
    const assistants = session.turns.filter((t) => t._tag === "Assistant" && t.text === "same answer")
    assert.equal(assistants.length, 1)
    assert.ok(!session.warnings.some((w) => w.code === "unsafe_records_skipped"))
  })
})
