import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { transplantSession } from "../src/core/orchestrator.ts"
import { IR_VERSION, Session } from "../src/ir/session.ts"
import { AppLayer } from "../src/layers.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const fixtures = join(root, "fixtures")

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(AppLayer), Effect.provide(NodeServices.layer)))

const bundleFiles = ["session.json", "handoff.md", "handoff.json", "manifest.json"]

const assertBundle = async (format: "claude" | "codex", ref: string, outDir: string) => {
  const result = await run(transplantSession(format, ref, { outDir }))
  assert.equal(result.outDir, outDir)
  assert.deepEqual(result.written, bundleFiles)

  for (const name of bundleFiles) {
    assert.ok(existsSync(join(outDir, name)), `${format} bundle must contain ${name}`)
  }

  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"))
  assert.equal(manifest.irVersion, IR_VERSION)
  assert.equal(manifest.format, format)
  assert.deepEqual(manifest.files, ["session.json", "handoff.md", "handoff.json"])
  assert.ok(!Number.isNaN(Date.parse(manifest.exportedAt)), "exportedAt must be ISO")

  const session = Schema.decodeUnknownSync(Session)(
    JSON.parse(readFileSync(join(outDir, "session.json"), "utf8")),
  )
  assert.equal(session.irVersion, IR_VERSION)
  assert.equal(session.source.format, format)
  assert.equal(session.id, manifest.sessionId)
  assert.ok(session.turns.length > 0, "sanitized session must keep at least one turn")

  assert.match(readFileSync(join(outDir, "handoff.md"), "utf8"), /## Safety/)
  const handoff = JSON.parse(readFileSync(join(outDir, "handoff.json"), "utf8"))
  assert.equal(handoff.sessionId, manifest.sessionId)
  assert.ok(handoff.safetyNote.toLowerCase().includes("untrusted"))
}

describe("transplant bundle (L3 portable)", () => {
  it("writes the four-file bundle for the claude fixture (recursive outDir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-transplant-claude-"))
    try {
      await assertBundle("claude", join(fixtures, "claude/sample.jsonl"), join(dir, "nested", "out"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("writes the four-file bundle for the codex fixture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-transplant-codex-"))
    try {
      await assertBundle("codex", join(fixtures, "codex/sample.jsonl"), join(dir, "out"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("fails with DecodeFailed when outDir is unusable (exists as a file)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resume-transplant-bad-"))
    try {
      const blocker = join(dir, "blocker")
      const { writeFileSync } = await import("node:fs")
      writeFileSync(blocker, "in the way")
      const failure = await run(
        transplantSession("codex", join(fixtures, "codex/sample.jsonl"), { outDir: blocker }),
      ).then(
        () => undefined,
        (error) => error,
      )
      assert.ok(failure !== undefined, "transplant into a file path must fail")
      assert.equal(failure._tag, "DecodeFailed")
      assert.equal(failure.format, "codex")
      assert.equal(failure.path, blocker)
      assert.match(failure.reason, /outDir unusable/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
