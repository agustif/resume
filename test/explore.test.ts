import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { listClaudeSubagentMetas, loadClaudeSubagent } from "../src/adapters/claude/subagents.ts"
import {
  PAGE_LIMIT_MAX,
  READ_CHARS_MAX,
  findTurns,
  sliceText,
  windowOf,
} from "../src/core/explore.ts"
import { AssistantTurn, ToolCall, ToolResult, ToolResultTurn, UserTurn } from "../src/ir/session.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const parent = join(root, "fixtures/claude/parent.jsonl")

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const user = (text: string): UserTurn => new UserTurn({ text })

const tool = (content: string): ToolResultTurn =>
  new ToolResultTurn({
    results: [
      new ToolResult({
        content,
        isError: false,
        unavailable: false,
        inert: true,
      }),
    ],
  })

describe("explore windows", () => {
  it("clamps a page to the max and reports the next offset", () => {
    const items = Array.from({ length: 100 }, (_, index) => index)
    const page = windowOf(items, 0, 100, PAGE_LIMIT_MAX)
    assert.equal(page.total, 100)
    assert.equal(page.limit, PAGE_LIMIT_MAX)
    assert.equal(page.clamped, true)
    assert.equal(page.items.length, PAGE_LIMIT_MAX)
    assert.equal(page.items[0], 0)
    assert.equal(page.nextFrom, PAGE_LIMIT_MAX)

    const rest = windowOf(items, page.nextFrom ?? 0, page.limit, PAGE_LIMIT_MAX)
    assert.equal(rest.from, PAGE_LIMIT_MAX)
    assert.equal(rest.items[0], PAGE_LIMIT_MAX)
    assert.equal(rest.nextFrom, PAGE_LIMIT_MAX * 2)
  })

  it("slices text and stops at the end", () => {
    const text = "abcdefghij"
    const first = sliceText(text, 0, 4)
    assert.equal(first.text, "abcd")
    assert.equal(first.total, 10)
    assert.equal(first.nextFrom, 4)
    assert.equal(first.clamped, false)

    const last = sliceText(text, 8, 4)
    assert.equal(last.text, "ij")
    assert.equal(last.nextFrom, null)

    const huge = sliceText("x".repeat(9000), 0, 9000)
    assert.equal(huge.chars, READ_CHARS_MAX)
    assert.equal(huge.clamped, true)
    assert.equal(huge.text.length, READ_CHARS_MAX)
    assert.equal(huge.nextFrom, READ_CHARS_MAX)
  })

  it("finds tool output case-insensitively and pages the hits", () => {
    const turns = [
      user("hello"),
      tool("ALPHA one"),
      new AssistantTurn({
        text: "noted",
        toolCalls: [new ToolCall({ name: "Bash", argsPreview: "ls", inert: true })],
      }),
      tool("alpha two"),
      tool("beta"),
    ]
    const found = findTurns(turns, "Alpha", 0, 1)
    assert.equal(found.total, 2)
    assert.equal(found.items.length, 1)
    assert.equal(found.items[0]?.index, 1)
    assert.match(found.items[0]?.line ?? "", /tool-result/)
    assert.equal(found.nextFrom, 1)

    const next = findTurns(turns, "Alpha", found.nextFrom ?? 0, 1)
    assert.equal(next.items[0]?.index, 3)
    assert.equal(next.nextFrom, null)

    const assistant = findTurns(turns, "bash", 0, 20)
    assert.deepEqual(
      assistant.items.map((hit) => hit.index),
      [2],
    )
    assert.equal(findTurns(turns, "missing", 0, 20).total, 0)
    assert.equal(findTurns(turns, "   ", 0, 20).total, 0)
  })
})

describe("claude explore loading", () => {
  it("lists subagent metadata without decoding the transcript", async () => {
    const metas = await run(listClaudeSubagentMetas(parent))
    assert.equal(metas.length, 1)
    assert.equal(metas[0]?.id, "a1")
    assert.equal(metas[0]?.agentType, "general-purpose")
    assert.equal(metas[0]?.description, "Research timeout alerts")
    assert.equal(metas[0]?.spawnDepth, 1)
  })

  it("opens one subagent by unique prefix and reports a miss", async () => {
    const one = await run(loadClaudeSubagent(parent, "a", 0))
    assert.equal(one._tag, "One")
    if (one._tag !== "One") return
    assert.equal(one.run.id, "a1")
    const text = one.run.turns
      .filter((turn) => turn._tag === "Assistant")
      .map((turn) => (turn._tag === "Assistant" ? (turn.text ?? "") : ""))
      .join("\n")
    assert.match(text, /gateway timeout/)

    const none = await run(loadClaudeSubagent(parent, "missing", 0))
    assert.equal(none._tag, "None")
  })
})
