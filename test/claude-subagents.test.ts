import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeClaudeFile } from "../src/adapters/claude/decode.ts"
import { loadClaudeSubagents } from "../src/adapters/claude/subagents.ts"
import { toHandoffPack } from "../src/core/handoff.ts"
import { sanitizeSession } from "../src/core/safety.ts"
import { Session } from "../src/ir/session.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const parent = join(root, "fixtures/claude/parent.jsonl")
const side = join(root, "fixtures/claude/parent/subagents/agent-a1.jsonl")

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

describe("claude subagents", () => {
  it("keeps sidechain records out of the main chain", async () => {
    const session = await run(decodeClaudeFile(side))
    assert.equal(
      session.turns.filter((turn) => turn._tag === "Assistant").length,
      0,
    )
  })

  it("decodes a sidechain file when asked", async () => {
    const session = await run(decodeClaudeFile(side, 300, { includeSidechain: true }))
    const text = session.turns
      .filter((turn) => turn._tag === "Assistant")
      .map((turn) => (turn._tag === "Assistant" ? turn.text : ""))
      .join("\n")
    assert.match(text, /gateway timeout/)
  })

  it("attaches sibling subagent transcripts and lists them on the handoff", async () => {
    const session = await run(decodeClaudeFile(parent))
    const subagents = await run(loadClaudeSubagents(parent))
    assert.equal(subagents.length, 1)
    assert.equal(subagents[0]?.id, "a1")
    assert.equal(subagents[0]?.description, "Research timeout alerts")
    const assistant = subagents[0]?.turns.find((turn) => turn._tag === "Assistant")
    assert.equal(assistant?._tag, "Assistant")
    assert.match(assistant?._tag === "Assistant" ? (assistant.text ?? "") : "", /gateway timeout/)

    const withAgents = new Session({
      irVersion: session.irVersion,
      id: session.id,
      source: session.source,
      meta: session.meta,
      turns: session.turns,
      warnings: session.warnings,
      subagents,
    })
    const pack = toHandoffPack(sanitizeSession(withAgents))
    assert.equal(pack.subagents?.length, 1)
    assert.match(pack.subagents?.[0] ?? "", /Research timeout alerts/)
    assert.match(pack.subagents?.[0] ?? "", /gateway timeout/)
    assert.match(pack.userRequests?.join("\n") ?? "", /timeout alerts firing/)
  })
})
