import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { indexSession, listSessions, searchIndexed } from "../core/index.js"
import { FORMAT_IDS, type FormatId } from "../ir/formats.js"

type RootFlags = {
  json: boolean
  cwd: Option.Option<string>
  verbose: boolean
  maxToolChars: Option.Option<number>
}

const formatArg = Argument.choice("format", FORMAT_IDS).pipe(
  Argument.withDescription("Session format (claude, codex, grok, ...)"),
)

const refArg = Argument.string("ref").pipe(
  Argument.withDescription("Session id, path, free-text query, or 'latest'"),
  Argument.withDefault("latest"),
)

const queryArg = Argument.string("query").pipe(
  Argument.withDescription("Search query across indexed sessions"),
)

const recentFlag = Flag.integer("recent").pipe(
  Flag.withDescription("Index the N most recent sessions instead of <ref>"),
  Flag.withDefault(0),
)

const rebuildFlag = Flag.boolean("rebuild").pipe(
  Flag.withDescription("Re-embed even when the stored index is fresh"),
  Flag.withDefault(false),
)

const skipVectorsFlag = Flag.boolean("skip-vectors").pipe(
  Flag.withDescription("Index/search with BM25 only, no local embeddings"),
  Flag.withDefault(false),
)

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("How many hits to print, max 40"),
  Flag.withDefault(10),
)

const fromFlag = Flag.integer("from").pipe(
  Flag.withDescription("Zero-based start index into the ranking"),
  Flag.withDefault(0),
)

const searchFormatFlag = Flag.choice("format", ["all", ...FORMAT_IDS] as const).pipe(
  Flag.withDescription("Restrict search to one format (default: all)"),
  Flag.withDefault("all" as const),
)

export const searchCommands = (
  resume: Command.Command<"resume", RootFlags, RootFlags>,
) => {
  const index = Command.make(
    "index",
    {
      format: formatArg,
      ref: refArg,
      recent: recentFlag,
      rebuild: rebuildFlag,
      skipVectors: skipVectorsFlag,
    },
    Effect.fn("cli.index")(function* ({ format, ref, recent, rebuild, skipVectors }) {
      const root = yield* resume
      const started = Date.now()
      const targets =
        recent > 0
          ? yield* listSessions(format, { cwd: Option.getOrUndefined(root.cwd) })
          : [
              {
                format,
                sessionId: ref,
                path: ref,
                updatedAtMs: 0,
              } as const,
            ]
      const selected = recent > 0 ? targets.slice(0, recent) : targets
      const results: Array<{ sessionId: string; chunks: number; vectors: boolean; cached: boolean }> = []
      for (const target of selected) {
        const result = yield* indexSession(target.format as FormatId, target.path, {
          cwd: Option.getOrUndefined(root.cwd),
          maxToolChars: Option.getOrUndefined(root.maxToolChars) ?? 0,
          rebuild,
          skipVectors,
        })
        results.push({
          sessionId: result.sessionId,
          chunks: result.chunks,
          vectors: result.vectors,
          cached: result.cached,
        })
        if (!root.json) {
          yield* Console.log(
            `${result.sessionId}  chunks=${result.chunks} vectors=${result.vectors ? "yes" : "no"}${result.cached ? " (cached)" : ""}`,
          )
        }
      }
      if (root.json) {
        yield* Console.log(JSON.stringify(results, null, 2))
        return
      }
      yield* Console.log(
        `indexed ${results.length} session(s) in ${Date.now() - started}ms${skipVectors ? " (BM25 only)" : ""}`,
      )
    }),
  ).pipe(
    Command.withDescription(
      "Decode, sanitize, and chunk sessions into the local hybrid index. Only sanitized text is stored.",
    ),
  )

  const search = Command.make(
    "search",
    {
      query: queryArg,
      format: searchFormatFlag,
      from: fromFlag,
      limit: limitFlag,
      skipVectors: skipVectorsFlag,
    },
    Effect.fn("cli.search")(function* ({ query, format, from, limit, skipVectors }) {
      const root = yield* resume
      const start = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0
      const size = Math.min(40, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 10))
      const result = yield* searchIndexed(query, {
        ...(format !== "all" ? { format: format as FormatId } : {}),
        limit: start + size,
        skipVectors,
      })
      if (root.json) {
        yield* Console.log(JSON.stringify(result, null, 2))
        return
      }
      for (const warning of result.warnings) {
        yield* Console.log(`warning: ${warning}`)
      }
      const page = result.hits.slice(start, start + size)
      if (page.length === 0) {
        yield* Console.log(
          result.total === 0
            ? "no hits — if the index is empty, run `resume index <format> latest` first"
            : "no hits on this page",
        )
        return
      }
      for (const hit of page) {
        yield* Console.log(
          `${hit.score.toFixed(3)} [${hit.sources.join("+")}] ${hit.format}/${hit.sessionId.slice(0, 8)} turn ${hit.turn} (${hit.kind})  ${hit.snippet}`,
        )
      }
      const next = start + size
      if (next < result.total) {
        yield* Console.log(`next: resume search ${JSON.stringify(query)} --from ${next} --limit ${size}`)
      } else {
        yield* Console.log("next: (end)")
      }
      const first = page[0]!
      yield* Console.log(
        `open: resume read ${first.format} ${first.sessionId} --turn ${first.turn}`,
      )
    }),
  ).pipe(
    Command.withDescription(
      "Hybrid BM25 + local-embedding search across indexed sessions. Falls back to BM25 when Ollama is down.",
    ),
  )

  return [index, search] as const
}
