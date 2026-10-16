import { Effect, FileSystem, Option, Path } from "effect"
import { turnBody, turnKind } from "../core/explore.js"
import type { Session, Turn } from "../ir/index.js"
import { resolveResumeDataDir } from "../platform/homes.js"

/** Indexed text per turn. Retrieval points back at the live transcript. */
export const INDEX_VERSION = 1
export const CHUNK_TEXT_MAX = 4000
export const EMBED_TEXT_MAX = 1500

export interface IndexChunk {
  readonly turn: number
  readonly kind: string
  readonly text: string
  readonly vector?: ReadonlyArray<number> | undefined
}

export interface SessionIndex {
  readonly version: number
  readonly format: string
  readonly sessionId: string
  readonly path: string
  readonly sourceMtimeMs: number
  readonly indexedAt: string
  readonly model?: string | undefined
  readonly chunks: ReadonlyArray<IndexChunk>
}

export const chunkSession = (session: Session): Array<Omit<IndexChunk, "vector">> => {
  const chunks: Array<Omit<IndexChunk, "vector">> = []
  session.turns.forEach((turn: Turn, index: number) => {
    const body = turnBody(turn).trim()
    if (!body) return
    chunks.push({
      turn: index,
      kind: turnKind(turn),
      text: body.length > CHUNK_TEXT_MAX ? body.slice(0, CHUNK_TEXT_MAX) : body,
    })
  })
  return chunks
}

const indexDirFor = (dataDir: string, pathApi: Path.Path): string =>
  pathApi.join(dataDir, "index", `v${INDEX_VERSION}`)

const fileFor = (
  dataDir: string,
  pathApi: Path.Path,
  format: string,
  sessionId: string,
): string =>
  pathApi.join(indexDirFor(dataDir, pathApi), format, `${encodeURIComponent(sessionId)}.json`)

const parseIndex = (raw: string): SessionIndex | undefined => {
  try {
    const value = JSON.parse(raw) as Partial<SessionIndex>
    if (
      value.version !== INDEX_VERSION ||
      typeof value.sessionId !== "string" ||
      !Array.isArray(value.chunks)
    ) {
      return undefined
    }
    return value as SessionIndex
  } catch {
    return undefined
  }
}

/** mtime of the underlying session file (`db#id` refs stat the db). */
export const sourceMtimeMs = Effect.fn("search.sourceMtimeMs")(function* (sourcePath: string) {
  const fs = yield* FileSystem.FileSystem
  const file = sourcePath.split("#")[0] ?? sourcePath
  const stat = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
  if (!stat) return undefined
  const mtime = Option.getOrUndefined(stat.mtime)
  return mtime ? mtime.getTime() : undefined
})

export const readSessionIndex = Effect.fn("search.readSessionIndex")(function* (
  format: string,
  sessionId: string,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const dataDir = yield* resolveResumeDataDir()
  const file = fileFor(dataDir, pathApi, format, sessionId)
  if (!(yield* fs.exists(file))) return undefined
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
  if (!raw) return undefined
  return parseIndex(raw)
})

export const writeSessionIndex = Effect.fn("search.writeSessionIndex")(function* (
  index: SessionIndex,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const dataDir = yield* resolveResumeDataDir()
  const dir = pathApi.join(indexDirFor(dataDir, pathApi), index.format)
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(
    fileFor(dataDir, pathApi, index.format, index.sessionId),
    JSON.stringify(index),
  )
})

export interface StoredIndex {
  readonly format: string
  readonly sessionId: string
  readonly index: SessionIndex
}

/** Load every stored index, optionally restricted to one format. Skips corrupt files. */
export const loadAllIndexes = Effect.fn("search.loadAllIndexes")(function* (
  format?: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const dataDir = yield* resolveResumeDataDir()
  const root = indexDirFor(dataDir, pathApi)
  if (!(yield* fs.exists(root))) return [] as ReadonlyArray<StoredIndex>

  const formats = format
    ? [format]
    : yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as Array<string>))

  const loaded: Array<StoredIndex> = []
  for (const fmt of formats) {
    const dir = pathApi.join(root, fmt)
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const raw = yield* fs
        .readFileString(pathApi.join(dir, name))
        .pipe(Effect.orElseSucceed(() => ""))
      if (!raw) continue
      const index = parseIndex(raw)
      if (index) loaded.push({ format: fmt, sessionId: index.sessionId, index })
    }
  }
  return loaded
})

export const indexSchemaNote =
  "v1: one JSON file per session under <dataDir>/index/v1/<format>/<sessionId>.json; keyed by source mtime for incremental refresh."
