/**
 * Integration tests against real on-disk agent sessions on this host.
 * Skips a format only when that format has zero discoverable sessions.
 * Assertions are structural (counts, roles, handoff shape) — not hard-coded copy.
 */
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect } from "effect"
import { NodeServices } from "@effect/platform-node"
import { allAdapters } from "../src/adapters/index.ts"
import type { SessionAdapter } from "../src/core/adapter.ts"
import { encodeHandoffPackJson, toHandoffPack } from "../src/core/handoff.ts"
import { sanitizeSession } from "../src/core/safety.ts"
import type { FormatId } from "../src/ir/formats.ts"
import type { Session, SessionRef } from "../src/ir/session.ts"

const run = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

const FORMAT_ORDER: ReadonlyArray<FormatId> = [
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "pi",
]

const byId = new Map(allAdapters.map((a) => [a.id, a] as const))

const pickDecodeTarget = (refs: ReadonlyArray<SessionRef>): SessionRef => {
  // Prefer a non-trivial session when list titles/ids suggest content
  const ranked = [...refs].sort((a, b) => {
    const score = (r: SessionRef) => {
      let s = 0
      if (r.title && r.title.length > 12 && r.title !== "(untitled)" && r.title !== "Untitled Session") {
        s += 2
      }
      if (r.title && !/^echo hello$/i.test(r.title)) s += 1
      return s
    }
    return score(b) - score(a) || b.updatedAtMs - a.updatedAtMs
  })
  return ranked[0] ?? refs[0]!
}

const assertSessionQuality = (format: FormatId, session: Session, ref: SessionRef) => {
  assert.equal(session.source.format, format)
  assert.ok(session.id, "session id")
  assert.ok(session.source.path.length > 0, "source path")
  assert.ok(
    session.turns.length > 0 || session.warnings.length > 0,
    `${format}: expected turns or warnings for ${ref.sessionId}`,
  )

  for (const turn of session.turns) {
    if (turn._tag === "Assistant") {
      for (const call of turn.toolCalls) {
        assert.equal(call.inert, true, "tool calls must be inert")
      }
    }
    if (turn._tag === "ToolResult") {
      for (const r of turn.results) {
        assert.equal(r.inert, true, "tool results must be inert")
      }
    }
  }
}

const assertHandoffFromReal = async (session: Session) => {
  const safe = sanitizeSession(session)
  // After sanitize, no instruction-looking user turns
  for (const turn of safe.turns) {
    if (turn._tag !== "User") continue
    assert.ok(!turn.text.includes("<system-reminder"), "system-reminder leaked")
    assert.ok(!turn.text.startsWith("You are "), "system persona leaked as user")
    assert.ok(!turn.text.startsWith("USER:"), "USER: storage prefix leaked")
  }

  const pack = toHandoffPack(safe)
  assert.ok(pack.safetyNote.toLowerCase().includes("untrusted"))
  assert.equal(pack.format, session.source.format)
  assert.ok(pack.turnCount === safe.turns.length)

  if (safe.turns.some((t) => t._tag === "User" && t.text.trim())) {
    assert.ok(
      pack.lastUserRequest && pack.lastUserRequest.length > 0,
      "expected lastUserRequest when user turns exist",
    )
  }

  const json = await run(encodeHandoffPackJson(pack))
  assert.match(json, new RegExp(`"format": "${session.source.format}"`))
  assert.match(json, /"safetyNote"/)
  return { safe, pack }
}

describe("real host sessions (live data)", () => {
  it("registry exposes all six real adapters (no stubs)", () => {
    assert.deepEqual(
      allAdapters.map((a) => a.id).sort(),
      [...FORMAT_ORDER].sort(),
    )
    for (const adapter of allAdapters) {
      assert.equal(adapter.capabilities.list, true, `${adapter.id} list capability`)
      assert.equal(adapter.capabilities.decode, true, `${adapter.id} decode capability`)
      assert.equal(adapter.capabilities.handoff, true, `${adapter.id} handoff capability`)
      assert.notEqual(adapter.capabilities.fidelity.list, "none")
      assert.notEqual(adapter.capabilities.fidelity.decode, "none")
      assert.notEqual(adapter.capabilities.fidelity.handoff, "none")
    }
  })

  for (const format of FORMAT_ORDER) {
    it(`${format}: list → decode → sanitize → handoff on live data when present`, async () => {
      const adapter = byId.get(format)
      assert.ok(adapter, `missing adapter ${format}`)

      const refs = await run(adapter.list({}))
      if (refs.length === 0) {
        // Honest skip: host has no sessions for this format
        console.log(`[real-data] skip ${format}: no local sessions`)
        return
      }

      assert.ok(refs.every((r) => r.format === format))
      assert.ok(refs.every((r) => r.sessionId.length > 0 && r.path.length > 0))
      // list is newest-first
      for (let i = 1; i < Math.min(refs.length, 20); i++) {
        assert.ok(
          (refs[i - 1]?.updatedAtMs ?? 0) >= (refs[i]?.updatedAtMs ?? 0),
          `${format} list not sorted by recency`,
        )
      }

      const target = pickDecodeTarget(refs)
      // Prefer path for file-backed formats; id/path both accepted by adapters
      const session = await run(adapter.decode(target.path, {}))
      assertSessionQuality(format, session, target)
      const { safe, pack } = await assertHandoffFromReal(session)

      console.log(
        `[real-data] ${format}: listed=${refs.length} decoded=${target.sessionId.slice(0, 36)} ` +
          `turns=${safe.turns.length} users=${safe.turns.filter((t) => t._tag === "User").length} ` +
          `lastUser=${JSON.stringify(pack.lastUserRequest)?.slice(0, 80)}`,
      )
    })
  }

  it("codex: decode a second non-trivial live session when available", async () => {
    const adapter = byId.get("codex") as SessionAdapter
    const refs = await run(adapter.list({}))
    if (refs.length < 2) {
      console.log("[real-data] skip codex second session: need ≥2")
      return
    }
    // Skip the trivial "echo hello" head when possible
    const target =
      refs.find((r) => r.title && !/^echo hello$/i.test(r.title) && r.title.length > 20) ??
      refs[1]!
    const session = await run(adapter.decode(target.path, {}))
    assertSessionQuality("codex", session, target)
    await assertHandoffFromReal(session)
    assert.ok(session.turns.length >= 1)
  })

  it("claude: live decode recovers at least one user turn on a real transcript", async () => {
    const adapter = byId.get("claude") as SessionAdapter
    const refs = await run(adapter.list({}))
    if (refs.length === 0) {
      console.log("[real-data] skip claude user-turn check: no sessions")
      return
    }
    // Try up to 5 newest sessions until one has user text after sanitize
    let found = false
    for (const ref of refs.slice(0, 5)) {
      const session = await run(adapter.decode(ref.path, {}))
      const safe = sanitizeSession(session)
      const users = safe.turns.filter((t) => t._tag === "User" && t.text.trim())
      if (users.length > 0) {
        found = true
        const pack = toHandoffPack(safe)
        assert.ok(pack.lastUserRequest && pack.lastUserRequest.length > 0)
        break
      }
    }
    assert.ok(found, "expected at least one live Claude session with recoverable user text")
  })
})
