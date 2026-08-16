import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { decodeCodexFile } from "../src/adapters/codex/decode.ts"
import { encodeHandoffPackJson, toHandoffPack } from "../src/core/handoff.ts"
import { sanitizeSession } from "../src/core/safety.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures")

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
