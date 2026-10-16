import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeClaudeFile } from "../src/adapters/claude/decode.ts"
import { toHandoffPack } from "../src/core/handoff.ts"
import { sanitizeSession } from "../src/core/safety.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const path = join(root, "fixtures/claude/compacted.jsonl")

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

describe("claude compaction", () => {
  it("keeps pre-compaction messages and does not treat the summary as the conversation", async () => {
    const session = await run(decodeClaudeFile(path))
    const users = session.turns
      .filter((turn) => turn._tag === "User")
      .map((turn) => (turn._tag === "User" ? turn.text : ""))
    assert.deepEqual(users, [
      "seeing the same betterstack timeout alerts",
      "keep finding the root cause",
      "fix it properly",
    ])
    assert.ok(users.every((text) => !text.includes("being continued")))
    assert.ok(session.turns.some((turn) => turn._tag === "Boundary" && turn.kind === "compact"))
    assert.ok(
      session.turns.some(
        (turn) => turn._tag === "Assistant" && turn.text?.includes("Pool wait, not the query."),
      ),
    )
    assert.ok(session.warnings.some((warning) => warning.code === "compaction_restored"))

    const pack = toHandoffPack(sanitizeSession(session))
    assert.match(pack.userRequests?.join("\n") ?? "", /betterstack timeout alerts/)
    assert.match(pack.userRequests?.join("\n") ?? "", /fix it properly/)
    assert.equal(pack.lastUserRequest?.includes("fix it properly"), true)
    assert.equal(pack.lastUserRequest?.includes("being continued"), false)
  })
})
