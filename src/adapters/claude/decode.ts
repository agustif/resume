import { Effect, FileSystem, Path, Schema } from "effect"
import { isGeneratedMetaText } from "../../core/safety.js"
import {
  AssistantTurn,
  BoundaryTurn,
  Session,
  SessionId,
  SessionMeta,
  SessionSource,
  ToolCall,
  ToolResult,
  ToolResultTurn,
  UserTurn,
  Warning,
  type Turn,
} from "../../ir/index.js"
import { readJsonlRecords } from "../../platform/jsonl.js"
import { contentText, isRecord, oneLine } from "../../platform/text.js"

const blocks = (content: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content.filter(isRecord)
  if (isRecord(content)) return [content]
  return []
}

const bound = (text: string, maxToolChars: number): string => {
  if (maxToolChars <= 0 || text.length <= maxToolChars) return text
  return `${text.slice(0, maxToolChars)}...`
}

const preview = (value: unknown, maxToolChars: number): string => {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))
  return bound(raw, maxToolChars)
}

const systemNote = (record: Record<string, unknown>): string =>
  typeof record["content"] === "string" ? record["content"] : ""

const renderRecord = (
  record: Record<string, unknown>,
  maxToolChars: number,
  includeSidechain: boolean,
  persisted: ReadonlyMap<string, string>,
): Turn | undefined => {
  const type = record["type"]
  if (type === "system" && record["subtype"] === "compact_boundary") {
    return new BoundaryTurn({
      kind: "compact",
      note: "Compaction boundary. Messages from before this point stay in the transcript.",
    })
  }
  if (type === "system" && record["subtype"] === "away_summary") {
    return new BoundaryTurn({
      kind: "away",
      note: systemNote(record) || "Away summary",
    })
  }
  if (type === "system" && record["subtype"] === "informational") {
    return new BoundaryTurn({
      kind: "status",
      note: systemNote(record) || "Status",
    })
  }
  if (type !== "user" && type !== "assistant") return undefined
  if (
    record["isCompactSummary"] ||
    record["isVirtual"] ||
    (!includeSidechain && record["isSidechain"])
  ) {
    return undefined
  }
  const message = record["message"]
  if (!isRecord(message)) return undefined
  const role = message["role"] === "user" || message["role"] === "assistant" ? message["role"] : type

  const texts: Array<string> = []
  const toolCalls: Array<ToolCall> = []
  const toolResults: Array<ToolResult> = []

  for (const block of blocks(message["content"])) {
    const blockType = block["type"]
    if (blockType === "thinking" || blockType === "redacted_thinking" || blockType === "signature") {
      continue
    }
    if (blockType === "text" || blockType === "input_text" || blockType === "output_text") {
      const text = block["text"]
      if (typeof text === "string" && text.trim() && !isGeneratedMetaText(text)) {
        texts.push(text)
      }
    } else if (blockType === "tool_use") {
      toolCalls.push(
        new ToolCall({
          ...(typeof block["id"] === "string" ? { id: block["id"] } : {}),
          name: typeof block["name"] === "string" ? block["name"] : "unknown",
          argsPreview: preview(block["input"] ?? {}, maxToolChars),
          inert: true,
        }),
      )
    } else if (blockType === "tool_result") {
      const raw = contentText(block["content"])
      const callId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : undefined
      const hydrated = callId ? persisted.get(callId) : undefined
      const stub =
        raw.includes("<persisted-output>") || raw.includes("[Old tool result content cleared]")
      const unavailable = hydrated === undefined && stub
      toolResults.push(
        new ToolResult({
          ...(callId !== undefined ? { callId } : {}),
          content: bound(hydrated ?? raw, maxToolChars),
          isError: Boolean(block["is_error"]),
          unavailable,
          inert: true,
        }),
      )
    } else if (blockType === "image") {
      texts.push("[image content unavailable]")
    }
  }

  const text = texts.join("\n")
  if (role === "user") {
    if (toolResults.length > 0 && !text) {
      return new ToolResultTurn({ results: toolResults })
    }
    if (!text && toolResults.length === 0) return undefined
    return new UserTurn({
      text: text || "(tool results)",
      ...(toolResults.length > 0 ? { toolResults } : {}),
    })
  }

  if (!text && toolCalls.length === 0 && toolResults.length === 0) return undefined
  if (toolResults.length > 0 && !text && toolCalls.length === 0) {
    return new ToolResultTurn({ results: toolResults })
  }
  return new AssistantTurn({
    ...(text ? { text } : {}),
    toolCalls,
  })
}

const parentOf = (record: Record<string, unknown>): string | undefined => {
  for (const key of ["parentUuid", "logicalParentUuid"] as const) {
    const v = record[key]
    if (typeof v === "string" && v) return v
  }
  return undefined
}

const isTurnType = (type: unknown): type is "user" | "assistant" =>
  type === "user" || type === "assistant"

const isSessionNote = (record: Record<string, unknown>): boolean =>
  record["type"] === "system" &&
  (record["subtype"] === "compact_boundary" ||
    record["subtype"] === "away_summary" ||
    record["subtype"] === "informational")

const timestampOf = (record: Record<string, unknown>): string =>
  typeof record["timestamp"] === "string" ? record["timestamp"] : ""

/**
 * Reconstruct the conversation from parent links.
 * Compaction rewires the live leaf onto a summary and leaves the earlier
 * transcript reachable only from older leaves. Walk those disjoint chains
 * too, plus sibling branches that only share a prefix with it (tool results
 * the live leaf no longer points at). A compact summary is not a substitute
 * for the messages it replaced.
 */
const selectChain = (
  records: ReadonlyArray<Record<string, unknown>>,
  includeSidechain: boolean,
): {
  chain: ReadonlyArray<Record<string, unknown>>
  warnings: ReadonlyArray<{ code: string; message: string }>
} => {
  const byUuid = new Map<string, Record<string, unknown>>()
  const fileIndex = new Map<string, number>()
  records.forEach((record, index) => {
    if (!includeSidechain && record["isSidechain"]) return
    const uuid = record["uuid"]
    if (typeof uuid !== "string" || !uuid || byUuid.has(uuid)) return
    byUuid.set(uuid, record)
    fileIndex.set(uuid, index)
  })

  const parented = new Set<string>()
  for (const record of byUuid.values()) {
    const parent = parentOf(record)
    if (parent) parented.add(parent)
  }

  const turnLeaves = [...byUuid.values()].filter((record) => {
    const uuid = record["uuid"]
    return typeof uuid === "string" && !parented.has(uuid) && isTurnType(record["type"])
  })

  const anyLeaves = [...byUuid.values()].filter((record) => {
    const uuid = record["uuid"]
    return typeof uuid === "string" && !parented.has(uuid)
  })

  const byTimestamp = (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    const order = timestampOf(a).localeCompare(timestampOf(b))
    if (order !== 0) return order
    const ia = fileIndex.get(String(a["uuid"])) ?? 0
    const ib = fileIndex.get(String(b["uuid"])) ?? 0
    return ia - ib
  }

  const leaf =
    turnLeaves.sort(byTimestamp).at(-1) ??
    anyLeaves.sort(byTimestamp).at(-1) ??
    [...byUuid.values()].filter((record) => isTurnType(record["type"])).sort(byTimestamp).at(-1)

  if (!leaf) {
    return {
      chain: records.filter((record) => isTurnType(record["type"]) || isSessionNote(record)),
      warnings: [
        {
          code: "parent_chain_fallback",
          message: "No Claude parent-chain leaf found; using chronological transcript records.",
        },
      ],
    }
  }

  const walk = (start: Record<string, unknown>): Set<string> => {
    const seen = new Set<string>()
    let current: Record<string, unknown> | undefined = start
    while (current) {
      const uuid = current["uuid"]
      if (typeof uuid !== "string" || seen.has(uuid)) break
      seen.add(uuid)
      const parent = parentOf(current)
      current = parent ? byUuid.get(parent) : undefined
    }
    return seen
  }

  const liveIds = walk(leaf)
  const extraIds = new Set<string>()
  for (const other of turnLeaves) {
    const uuid = other["uuid"]
    if (typeof uuid !== "string" || liveIds.has(uuid)) continue
    for (const id of walk(other)) {
      if (!liveIds.has(id)) extraIds.add(id)
    }
  }

  for (const record of byUuid.values()) {
    if (!isSessionNote(record)) continue
    const uuid = record["uuid"]
    if (typeof uuid === "string") extraIds.add(uuid)
  }

  let liveStart = ""
  for (const id of liveIds) {
    const record = byUuid.get(id)
    if (!record || !isTurnType(record["type"])) continue
    const stamp = timestampOf(record)
    if (stamp && (liveStart === "" || stamp < liveStart)) liveStart = stamp
  }

  let compactionTurns = 0
  let siblingTurns = 0
  for (const id of extraIds) {
    const record = byUuid.get(id)
    if (!record || !isTurnType(record["type"])) continue
    if (liveStart !== "" && timestampOf(record) < liveStart) compactionTurns += 1
    else siblingTurns += 1
  }

  const kept = new Set<string>([...liveIds, ...extraIds])
  const chain = [...kept]
    .map((uuid) => byUuid.get(uuid))
    .filter((record): record is Record<string, unknown> => record !== undefined)
    .filter((record) => isTurnType(record["type"]) || isSessionNote(record))
    .sort(byTimestamp)

  const warnings: Array<{ code: string; message: string }> = []
  if (compactionTurns > 0) {
    warnings.push({
      code: "compaction_restored",
      message: `Restored ${compactionTurns} pre-compaction message(s) the live parent chain no longer reaches.`,
    })
  }
  if (siblingTurns > 0) {
    warnings.push({
      code: "sibling_restored",
      message: `Included ${siblingTurns} sibling message(s) the latest parent chain does not reach.`,
    })
  }

  return { chain, warnings }
}

const titleFromRecords = (
  records: ReadonlyArray<Record<string, unknown>>,
  turns: ReadonlyArray<Turn>,
): string | undefined => {
  for (const [type, field] of [
    ["custom-title", "customTitle"],
    ["ai-title", "aiTitle"],
    ["summary", "summary"],
  ] as const) {
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]
      if (r?.["type"] === type && typeof r[field] === "string") {
        return oneLine(r[field], 200)
      }
    }
  }
  const firstUser = turns.find((t) => t._tag === "User" && t.text.trim())
  return firstUser && firstUser._tag === "User" ? oneLine(firstUser.text, 200) : undefined
}

const safeFileName = (rawPath: string): string | undefined => {
  const name = rawPath.split(/[/\\]/).pop() ?? ""
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return undefined
  return name
}

const toolResultDirs = (sessionFile: string, pathApi: Path.Path): ReadonlyArray<string> => {
  const dir = pathApi.dirname(sessionFile)
  const id = pathApi.basename(sessionFile).replace(/\.jsonl$/, "")
  return [
    pathApi.join(dir, id, "tool-results"),
    pathApi.join(dir, "tool-results"),
    pathApi.join(pathApi.dirname(dir), "tool-results"),
  ]
}

/**
 * Large tool results are stored beside the session. Read only a basename from
 * that session's tool-results directory. Do not follow the absolute path in
 * the transcript.
 */
const loadPersistedOutputs = Effect.fn("claude.loadPersistedOutputs")(function* (
  sessionFile: string,
  records: ReadonlyArray<Record<string, unknown>>,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const dirs = toolResultDirs(sessionFile, pathApi)
  const hydrated = new Map<string, string>()
  let missing = 0

  for (const record of records) {
    const message = record["message"]
    if (!isRecord(message)) continue
    for (const block of blocks(message["content"])) {
      if (block["type"] !== "tool_result") continue
      const callId = block["tool_use_id"]
      if (typeof callId !== "string" || hydrated.has(callId)) continue
      const raw = contentText(block["content"])
      const names = [...raw.matchAll(/Full output saved to:\s*(\S+)/g)]
        .map((match) => safeFileName(match[1] ?? ""))
        .filter((name): name is string => name !== undefined)
      if (names.length === 0) continue

      let text: string | undefined
      for (const dir of dirs) {
        for (const name of names) {
          const full = pathApi.join(dir, name)
          const body = yield* fs.readFileString(full).pipe(Effect.orElseSucceed(() => ""))
          if (body) {
            text = body
            break
          }
        }
        if (text) break
      }
      if (text) hydrated.set(callId, text)
      else missing += 1
    }
  }

  return { hydrated, missing }
})

export const decodeClaudeFile = Effect.fn("claude.decodeFile")(function* (
  path: string,
  maxToolChars = 300,
  opts?: { readonly includeSidechain?: boolean },
) {
  const includeSidechain = opts?.includeSidechain === true
  const { records, malformed } = yield* readJsonlRecords(path, "claude")
  const warnings: Array<Warning> = []
  if (malformed > 0) {
    warnings.push(
      new Warning({
        code: "malformed_records_skipped",
        message: `Skipped ${malformed} malformed Claude transcript record(s).`,
      }),
    )
  }

  const { chain, warnings: chainWarnings } = selectChain(records, includeSidechain)
  for (const warning of chainWarnings) {
    warnings.push(new Warning(warning))
  }

  const { hydrated, missing } = yield* loadPersistedOutputs(path, chain)
  if (hydrated.size > 0) {
    warnings.push(
      new Warning({
        code: "persisted_output_hydrated",
        message: `Inlined ${hydrated.size} tool result(s) from tool-results/.`,
      }),
    )
  }
  if (missing > 0) {
    warnings.push(
      new Warning({
        code: "persisted_output_missing",
        message: `${missing} tool result(s) point at a tool-results file that was not readable.`,
      }),
    )
  }

  const turns: Array<Turn> = []
  for (const record of chain) {
    const turn = renderRecord(record, maxToolChars, includeSidechain, hydrated)
    if (turn) turns.push(turn)
  }

  const sessionId = path.split(/[/\\]/).pop()?.replace(/\.jsonl$/, "") ?? path
  const cwd = chain.map((r) => r["cwd"]).find((v): v is string => typeof v === "string")
  const branch = [...chain]
    .reverse()
    .map((r) => r["gitBranch"])
    .find((v): v is string => typeof v === "string")
  const timestamps = chain
    .map((r) => r["timestamp"])
    .filter((t): t is string => typeof t === "string")

  return new Session({
    irVersion: "0.1.0",
    id: Schema.decodeUnknownSync(SessionId)(sessionId),
    source: new SessionSource({ format: "claude", path }),
    meta: new SessionMeta({
      ...(titleFromRecords(records, turns) !== undefined
        ? { title: titleFromRecords(records, turns) }
        : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(timestamps[0] !== undefined ? { createdAt: timestamps[0] } : {}),
      ...(timestamps.at(-1) !== undefined ? { updatedAt: timestamps.at(-1) } : {}),
    }),
    turns,
    warnings,
  })
})
