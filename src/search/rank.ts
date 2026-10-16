/**
 * Small BM25 implementation over pre-tokenized chunks.
 * Pure functions — no services — so ranking is unit-testable.
 */

export const tokenize = (text: string): Array<string> =>
  text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1)

export interface ScoredDoc {
  readonly doc: number
  readonly score: number
}

/**
 * BM25 scores for every doc (aligned with `docs`), k1=1.2, b=0.75.
 * idf uses the corpus itself; empty queries score all zero.
 */
export const bm25Scores = (
  queryTerms: ReadonlyArray<string>,
  docs: ReadonlyArray<ReadonlyArray<string>>,
  k1 = 1.2,
  b = 0.75,
): Array<number> => {
  const uniqueQuery = [...new Set(queryTerms)]
  if (uniqueQuery.length === 0 || docs.length === 0) {
    return docs.map(() => 0)
  }

  const docFreq = new Map<string, number>()
  const docLens = docs.map((tokens) => {
    const seen = new Set<string>()
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token)
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
      }
    }
    return tokens.length
  })
  const avgLen = docLens.reduce((a, c) => a + c, 0) / docs.length || 1

  return docs.map((tokens, index) => {
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    let score = 0
    for (const term of uniqueQuery) {
      const count = tf.get(term) ?? 0
      if (count === 0) continue
      const df = docFreq.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      const norm = count * (k1 + 1) / (count + k1 * (1 - b + (b * docLens[index]!) / avgLen))
      score += idf * norm
    }
    return score
  })
}

/**
 * Reciprocal-rank fusion over ranked doc-id lists (best-first).
 * Merges BM25 and vector rankings without score normalization.
 */
export const reciprocalRankFuse = (
  rankings: ReadonlyArray<ReadonlyArray<number>>,
  k = 60,
): Map<number, number> => {
  const fused = new Map<number, number>()
  for (const ranking of rankings) {
    ranking.forEach((doc, rank) => {
      fused.set(doc, (fused.get(doc) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return fused
}

/** Cosine similarity for equal-length vectors. 0 when degenerate. */
export const cosineSimilarity = (
  a: ReadonlyArray<number>,
  b: ReadonlyArray<number>,
): number => {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
