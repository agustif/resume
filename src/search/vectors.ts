import { Effect } from "effect"
import { Schema } from "effect"

/**
 * Local Ollama embeddings. localhost only, never a hosted API:
 * session text must not leave the machine for search indexing.
 */

export class EmbedUnavailable extends Schema.TaggedError<EmbedUnavailable>()(
  "EmbedUnavailable",
  { reason: Schema.String },
) {}

export interface EmbedConfig {
  readonly host: string
  readonly model: string
  readonly timeoutMs: number
}

export const defaultEmbedConfig = (): EmbedConfig => ({
  host: process.env["RESUME_OLLAMA_HOST"] ?? "http://localhost:11434",
  model: process.env["RESUME_EMBED_MODEL"] ?? "snowflake-arctic-embed2",
  timeoutMs: 30_000,
})

const postEmbed = (
  config: EmbedConfig,
  input: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<Array<Array<number>>> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const response = await fetch(`${config.host}/api/embed`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: config.model, input }),
            signal: controller.signal,
          })
          if (!response.ok) {
            throw new Error(`ollama embed HTTP ${response.status}`)
          }
          const body = (await response.json()) as { embeddings?: Array<Array<number>> }
          if (!Array.isArray(body.embeddings)) {
            throw new Error("ollama embed response had no embeddings array")
          }
          return body.embeddings
        } finally {
          clearTimeout(timer)
        }
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EmbedUnavailable({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      ),
    ),
  )

/** Embed one batch. Fails with EmbedUnavailable — callers degrade to BM25. */
export const embedBatch = Effect.fn("search.embedBatch")(function* (
  config: EmbedConfig,
  inputs: ReadonlyArray<string>,
) {
  if (inputs.length === 0) return [] as ReadonlyArray<ReadonlyArray<number>>
  return yield* Effect.tryPromise({
    try: () => postEmbed(config, inputs, config.timeoutMs),
    catch: (cause) =>
      cause instanceof EmbedUnavailable
        ? cause
        : new EmbedUnavailable({ reason: String(cause) }),
  })
})

/** Embed a single query string with a shorter timeout. */
export const embedQuery = Effect.fn("search.embedQuery")(function* (
  config: EmbedConfig,
  query: string,
) {
  const batches = yield* embedBatch({ ...config, timeoutMs: 8_000 }, [query])
  const first = batches[0]
  if (!first) {
    return yield* new EmbedUnavailable({ reason: "empty embedding response" })
  }
  return first
})
