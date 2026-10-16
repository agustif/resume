export * from "./adapter.js"
export * from "./errors.js"
export * from "./handoff.js"
export * from "./orchestrator.js"
export * from "./registry.js"
export * from "./safety.js"

import { Effect } from "effect"
import type { FormatId } from "../ir/formats.js"
import { sanitizeSession } from "./safety.js"
import { AdapterRegistry } from "./registry.js"
import {
  bm25Scores,
  cosineSimilarity,
  reciprocalRankFuse,
  tokenize,
} from "../search/rank.js"
import {
  chunkSession,
  loadAllIndexes,
  readSessionIndex,
  sourceMtimeMs,
  writeSessionIndex,
  type SessionIndex,
} from "../search/store.js"
import { defaultEmbedConfig, embedBatch, embedQuery } from "../search/vectors.js"

export interface IndexResult {
  readonly sessionId: string
  readonly path: string
  readonly chunks: number
  readonly vectors: boolean
  readonly cached: boolean
}

export interface IndexOpts {
  readonly cwd?: string | undefined
  readonly maxToolChars?: number | undefined
  readonly rebuild?: boolean | undefined
  readonly skipVectors?: boolean | undefined
}

/**
 * Decode → sanitize → chunk → (embed) → store. Refresh is keyed on the
 * source file mtime; `--rebuild` forces re-embedding. Only sanitized text
 * is ever stored, so the index cannot resurrect stripped wrappers.
 */
export const indexSession = Effect.fn("resume.indexSession")(function* (
  format: FormatId,
  ref: string,
  opts: IndexOpts,
) {
  const registry = yield* AdapterRegistry
  const adapter = yield* registry.get(format)
  const session = sanitizeSession(
    yield* adapter.decode(ref, { cwd: opts.cwd, maxToolChars: opts.maxToolChars ?? 0 }),
  )

  const mtime = yield* sourceMtimeMs(session.source.path)
  if (!opts.rebuild) {
    const existing = yield* readSessionIndex(format, session.id)
    if (
      existing &&
      mtime !== undefined &&
      existing.sourceMtimeMs === mtime &&
      (opts.skipVectors || existing.chunks.every((c) => c.vector !== undefined))
    ) {
      return {
        sessionId: session.id,
        path: session.source.path,
        chunks: existing.chunks.length,
        vectors: existing.chunks.some((c) => c.vector !== undefined),
        cached: true,
      } satisfies IndexResult
    }
  }

  const chunks = chunkSession(session)
  let vectors = false
  let withVectors = chunks.map((c) => ({ ...c, vector: undefined as ReadonlyArray<number> | undefined }))
  if (!opts.skipVectors && chunks.length > 0) {
    const config = defaultEmbedConfig()
    const embedded = yield* embedBatch(
      config,
      chunks.map((c) =>
        c.text.length > 1500 ? c.text.slice(0, 1500) : c.text,
      ),
    ).pipe(
      Effect.mapError(() => undefined),
      Effect.orElseSucceed(() => undefined as unknown as ReadonlyArray<ReadonlyArray<number>> | undefined),
    )
    if (embedded && embedded.length === chunks.length) {
      vectors = true
      withVectors = chunks.map((c, i) => ({ ...c, vector: embedded[i] }))
    }
  }

  const index: SessionIndex = {
    version: 1,
    format,
    sessionId: session.id,
    path: session.source.path,
    sourceMtimeMs: mtime ?? 0,
    indexedAt: new Date().toISOString(),
    ...(vectors ? { model: defaultEmbedConfig().model } : {}),
    chunks: withVectors,
  }
  yield* writeSessionIndex(index)
  return {
    sessionId: session.id,
    path: session.source.path,
    chunks: withVectors.length,
    vectors,
    cached: false,
  } satisfies IndexResult
})

export interface SearchHit {
  readonly format: string
  readonly sessionId: string
  readonly path: string
  readonly turn: number
  readonly kind: string
  readonly snippet: string
  readonly score: number
  readonly sources: ReadonlyArray<"bm25" | "vector">
}

export interface SearchOpts {
  readonly format?: FormatId | undefined
  readonly limit?: number | undefined
  readonly skipVectors?: boolean | undefined
}

const snippetOf = (text: string): string => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed.length > 160 ? `${collapsed.slice(0, 160)}...` : collapsed
}

/**
 * Hybrid search over stored indexes: BM25 always runs; a local Ollama
 * embedding (localhost only) adds a vector ranking when the chunks carry
 * vectors and the daemon answers. Rankings fuse with reciprocal-rank fusion.
 * No index → empty hits; Ollama down → BM25-only with a warning.
 */
export const searchIndexed = Effect.fn("resume.searchIndexed")(function* (
  rawQuery: string,
  opts: SearchOpts,
) {
  const query = rawQuery.trim()
  const stored = yield* loadAllIndexes(opts.format)
  const warnings: Array<string> = []

  const flat: Array<{
    format: string
    sessionId: string
    path: string
    turn: number
    kind: string
    text: string
    tokens: Array<string>
    vector?: ReadonlyArray<number> | undefined
  }> = []
  for (const { format, sessionId, index } of stored) {
    for (const chunk of index.chunks) {
      flat.push({
        format,
        sessionId,
        path: index.path,
        turn: chunk.turn,
        kind: chunk.kind,
        text: chunk.text,
        tokens: tokenize(chunk.text),
        vector: chunk.vector,
      })
    }
  }

  if (query.length === 0 || flat.length === 0) {
    return { total: 0, hits: [] as ReadonlyArray<SearchHit>, vectorsUsed: false, warnings }
  }

  const queryTokens = tokenize(query)
  const bm25 = bm25Scores(
    queryTokens,
    flat.map((c) => c.tokens),
  )
  const bm25Ranking = flat
    .map((_, i) => i)
    .filter((i) => (bm25[i] ?? 0) > 0)
    .sort((a, b) => (bm25[b] ?? 0) - (bm25[a] ?? 0))
  const rankings: Array<ReadonlyArray<number>> = [bm25Ranking]
  const bm25Set = new Set(bm25Ranking)
  let vectorsUsed = false

  if (!opts.skipVectors) {
    const queryVector = yield* embedQuery(defaultEmbedConfig(), query).pipe(
      Effect.mapError(() => undefined),
      Effect.orElseSucceed(() => undefined as ReadonlyArray<number> | undefined),
    )
    if (queryVector) {
      const scored = flat
        .map((chunk, i) => ({ i, s: chunk.vector ? cosineSimilarity(queryVector, chunk.vector) : 0 }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 50)
        .map((r) => r.i)
      if (scored.length > 0) {
        vectorsUsed = true
        rankings.push(scored)
      }
    } else {
      warnings.push("local embeddings unavailable (is ollama up?); BM25 only")
    }
  }

  const fused = reciprocalRankFuse(rankings)
  const vectorSet = new Set(rankings[1] ?? [])
  const hits = [...fused.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([doc, score]) => {
      const chunk = flat[doc]!
      const sources: Array<"bm25" | "vector"> = []
      if (bm25Set.has(doc)) sources.push("bm25")
      if (vectorSet.has(doc)) sources.push("vector")
      return {
        format: chunk.format,
        sessionId: chunk.sessionId,
        path: chunk.path,
        turn: chunk.turn,
        kind: chunk.kind,
        snippet: snippetOf(chunk.text),
        score: Math.round(score * 1000) / 1000,
        sources,
      } satisfies SearchHit
    })

  const limit = opts.limit ?? 10
  return { total: hits.length, hits: hits.slice(0, Math.max(1, limit)), vectorsUsed, warnings }
})
