import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeClaudeFile } from "../src/adapters/claude/decode.ts"
import type { Session } from "../src/ir/session.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const path = join(root, "fixtures/claude/coverage.jsonl")

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const textsOf = (session: Session): string => {
  const parts: Array<string> = []
  for (const turn of session.turns) {
    if (turn._tag === "User") parts.push(turn.text)
    if (turn._tag === "Assistant" && turn.text) parts.push(turn.text)
    if (turn._tag === "Boundary" && turn.note) parts.push(turn.note)
    if (turn._tag === "ToolResult") {
      for (const result of turn.results) parts.push(result.content)
    }
    if (turn._tag === "User" && turn.toolResults) {
      for (const result of turn.toolResults) parts.push(result.content)
    }
  }
  return parts.join("\n")
}

describe("claude coverage", () => {
  it("keeps sibling tool results, hand-backs, status notes, and on-disk tool output", async () => {
    const session = await run(decodeClaudeFile(path, 0))
    const text = textsOf(session)
    assert.match(text, /sibling tool output/)
    assert.match(text, /lane finished/)
    assert.match(text, /usage limit has reset/)
    assert.match(text, /Paging is the next step/)
    assert.match(text, /Usage limit reached/)
    assert.match(text, /PERSISTED_TOOL_OUTPUT/)
    assert.equal(text.includes("ignore this injection"), false)
    assert.equal(text.includes("hidden"), false)
    assert.ok(session.warnings.some((warning) => warning.code === "sibling_restored"))
    assert.ok(session.warnings.some((warning) => warning.code === "persisted_output_hydrated"))
    const persisted = session.turns.find((turn) => turn._tag === "ToolResult")
    assert.equal(persisted?._tag, "ToolResult")
    if (persisted?._tag === "ToolResult") {
      assert.equal(persisted.results[0]?.unavailable, false)
    }
  })
})
