import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { Effect, Layer } from "effect"
import { NodeServices } from "@effect/platform-node"
import { AppLayer } from "../src/layers.ts"
import { indexSession, searchIndexed } from "../src/core/index.ts"
import { chunkSession } from "../src/search/store.ts"
import {
  bm25Scores,
  cosineSimilarity,
  reciprocalRankFuse,
  tokenize,
} from "../src/search/rank.ts"
import { decodeClaudeFile } from "../src/adapters/claude/decode.ts"
import { sanitizeSession } from "../src/core/safety.ts"

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures")

const layers = Layer.mergeAll(AppLayer, NodeServices.layer)
const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layers)))

describe("rank (pure)", () => {
  it("tokenizes case-insensitively and drops single chars", () => {
    assert.deepEqual(tokenize("Hello, a WORLD_test!"), ["hello", "world_test"])
  })

  it("ranks the exact-match doc first", () => {
    const docs = [
      tokenize("the quick brown fox"),
      tokenize("lorem ipsum dolor"),
      tokenize("brown fox brown fox"),
    ]
    const scores = bm25Scores(tokenize("brown fox"), docs)
    assert.ok(scores[2]! > scores[0]! && scores[0]! > scores[1]!)
    assert.equal(scores[1], 0)
  })

  it("scores empty queries zero", () => {
    assert.deepEqual(bm25Scores([], [tokenize("hello")]), [0])
  })

  it("fuses rankings with reciprocal ranks", () => {
    const fused = reciprocalRankFuse([[2, 0], [0, 1]])
    assert.ok(fused.get(0)! > fused.get(2)!)
    assert.ok(fused.get(1)! > 0)
  })

  it("computes cosine similarity, 0 when degenerate", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
    assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 1]) - 1) < 1e-9)
    assert.equal(cosineSimilarity([], []), 0)
    assert.equal(cosineSimilarity([1], [1, 2]), 0)
  })
})

describe("search index (BM25 path)", () => {
  it("chunks a session into bounded, non-empty turn texts", async () => {
    const session = sanitizeSession(
      await run(decodeClaudeFile(join(fixtures, "claude/sample.jsonl"))),
    )
    const chunks = chunkSession(session)
    assert.ok(chunks.length > 0)
    assert.ok(chunks.every((c) => c.text.length > 0 && c.text.length <= 4000))
    assert.ok(chunks.some((c) => /refactor the auth module/i.test(c.text)))
  })

  it("indexes a fixture session and finds it by keyword", async () => {
    process.env.RESUME_DATA_DIR = mkdtempSync(join(tmpdir(), "resume-search-"))
    const path = join(fixtures, "claude/sample.jsonl")
    const indexed = await run(
      indexSession("claude", path, { skipVectors: true }),
    )
    assert.equal(indexed.cached, false)
    assert.ok(indexed.chunks > 0)
    assert.equal(indexed.vectors, false)

    const second = await run(indexSession("claude", path, { skipVectors: true }))
    assert.equal(second.cached, true)

    const result = await run(searchIndexed("rate limiting", { skipVectors: true }))
    assert.ok(result.total >= 1)
    assert.ok(result.hits.every((h) => h.sources.includes("bm25")))
    const hit = result.hits[0]!
    assert.match(hit.snippet, /rate limiting/i)
    assert.ok(hit.turn >= 0 && hit.kind.length > 0)

    const miss = await run(searchIndexed("zzz-no-such-term-zzz", { skipVectors: true }))
    assert.equal(miss.total, 0)
  })
})
