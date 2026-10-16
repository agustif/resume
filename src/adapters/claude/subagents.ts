import { Effect, FileSystem, Path, Result } from "effect"
import { Warning } from "../../ir/index.js"
import { SubagentRun } from "../../ir/session.js"
import { isRecord } from "../../platform/text.js"
import { decodeClaudeFile } from "./decode.js"

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined

const readMeta = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {}
  try {
    const value = JSON.parse(raw) as unknown
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

export interface ClaudeSubagentMeta {
  id: string
  path: string
  agentType?: string | undefined
  description?: string | undefined
  toolUseId?: string | undefined
  parentAgentId?: string | undefined
  spawnDepth?: number | undefined
  isFork?: boolean | undefined
}

const metaFields = (
  meta: Record<string, unknown>,
): Omit<ClaudeSubagentMeta, "id" | "path"> => {
  const agentType = str(meta["agentType"])
  const description = str(meta["description"])
  const toolUseId = str(meta["toolUseId"])
  const parentAgentId = str(meta["parentAgentId"])
  const spawnDepth = typeof meta["spawnDepth"] === "number" ? meta["spawnDepth"] : undefined
  const isFork = meta["isFork"] === true ? true : undefined
  return {
    ...(agentType !== undefined ? { agentType } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(toolUseId !== undefined ? { toolUseId } : {}),
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    ...(spawnDepth !== undefined ? { spawnDepth } : {}),
    ...(isFork !== undefined ? { isFork } : {}),
  }
}

const subagentDir = (sessionPath: string, pathApi: Path.Path): string => {
  const sessionId = pathApi.basename(sessionPath).replace(/\.jsonl$/, "")
  return pathApi.join(pathApi.dirname(sessionPath), sessionId, "subagents")
}

/**
 * Sidecar metadata only. Listing agents does not decode their transcripts.
 */
export const listClaudeSubagentMetas = Effect.fn("claude.listSubagentMetas")(function* (
  sessionPath: string,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const dir = subagentDir(sessionPath, pathApi)
  if (!(yield* fs.exists(dir))) return [] as ReadonlyArray<ClaudeSubagentMeta>

  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  const jsonl = names.filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl")).sort()

  return yield* Effect.forEach(
    jsonl,
    (name) =>
      Effect.gen(function* () {
        const id = name.replace(/^agent-/, "").replace(/\.jsonl$/, "")
        const raw = yield* fs
          .readFileString(pathApi.join(dir, name.replace(/\.jsonl$/, ".meta.json")))
          .pipe(Effect.orElseSucceed(() => ""))
        return {
          id,
          path: pathApi.join(dir, name),
          ...metaFields(readMeta(raw)),
        } satisfies ClaudeSubagentMeta
      }),
    { concurrency: 8 },
  )
})

const runFromMeta = (
  meta: ClaudeSubagentMeta,
  turns: SubagentRun["turns"],
  warnings: SubagentRun["warnings"],
  updatedAt?: string,
): SubagentRun =>
  new SubagentRun({
    id: meta.id,
    path: meta.path,
    turns,
    warnings,
    ...(meta.agentType !== undefined ? { agentType: meta.agentType } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.toolUseId !== undefined ? { toolUseId: meta.toolUseId } : {}),
    ...(meta.parentAgentId !== undefined ? { parentAgentId: meta.parentAgentId } : {}),
    ...(meta.spawnDepth !== undefined ? { spawnDepth: meta.spawnDepth } : {}),
    ...(meta.isFork !== undefined ? { isFork: meta.isFork } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  })

const decodeOne = Effect.fn("claude.decodeSubagent")(function* (
  meta: ClaudeSubagentMeta,
  maxToolChars: number,
) {
  const decoded = yield* Effect.result(
    decodeClaudeFile(meta.path, maxToolChars, { includeSidechain: true }),
  )
  if (Result.isFailure(decoded)) {
    return runFromMeta(meta, [], [
      new Warning({
        code: "subagent_decode_failed",
        message: `Failed to decode ${meta.id}.`,
      }),
    ])
  }
  const session = decoded.success
  return runFromMeta(meta, session.turns, session.warnings, session.meta.updatedAt)
})

export type SubagentMatch =
  | { readonly _tag: "None" }
  | { readonly _tag: "Many"; readonly ids: ReadonlyArray<string> }
  | { readonly _tag: "One"; readonly run: SubagentRun }

/** Decode a single subagent. `id` may be a unique prefix. */
export const loadClaudeSubagent = Effect.fn("claude.loadSubagent")(function* (
  sessionPath: string,
  id: string,
  maxToolChars = 0,
) {
  const metas = yield* listClaudeSubagentMetas(sessionPath)
  const needle = id.trim()
  const matches = metas.filter((meta) => meta.id === needle || meta.id.startsWith(needle))
  const only = matches.length === 1 ? matches[0] : undefined
  if (!only) {
    if (matches.length === 0) return { _tag: "None" } as const
    return { _tag: "Many", ids: matches.map((meta) => meta.id) } as const
  }
  const run = yield* decodeOne(only, maxToolChars)
  return { _tag: "One", run } as const
})

/**
 * Claude stores each spawned agent as `<sessionId>/subagents/agent-<id>.jsonl`
 * next to the parent transcript. Those records are marked `isSidechain`, so
 * the main-chain decoder skips them. Decode that directory as child runs.
 */
export const loadClaudeSubagents = Effect.fn("claude.loadSubagents")(function* (
  sessionPath: string,
  maxToolChars = 300,
) {
  const metas = yield* listClaudeSubagentMetas(sessionPath)
  return yield* Effect.forEach(metas, (meta) => decodeOne(meta, maxToolChars), { concurrency: 4 })
})
