import { Effect, Schema } from "effect"
import { isGeneratedMetaText } from "../../core/safety.js"
import {
  AssistantTurn,
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

const renderRecord = (
  record: Record<string, unknown>,
  maxToolChars: number,
): Turn | undefined => {
  const type = record["type"]
  if (type !== "user" && type !== "assistant") return undefined
  if (
    record["isMeta"] ||
    record["isCompactSummary"] ||
    record["isVirtual"] ||
    record["isVisibleInTranscriptOnly"] ||
    record["isSidechain"]
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
          argsPreview: oneLine(block["input"] ?? {}, maxToolChars),
          inert: true,
        }),
      )
    } else if (blockType === "tool_result") {
      const raw = contentText(block["content"])
      const unavailable =
        raw.includes("<persisted-output>") || raw.includes("[Old tool result content cleared]")
      toolResults.push(
        new ToolResult({
          ...(typeof block["tool_use_id"] === "string" ? { callId: block["tool_use_id"] } : {}),
          content: unavailable ? "[output summarized/stored elsewhere]" : oneLine(raw, maxToolChars),
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

/**
 * Reconstruct conversation chain from parentUuid leaf, else chronological.
 * Index ALL uuid-bearing main-chain records (attachment/progress/etc.) so walks
 * do not die at intermediate non-turn nodes; still only *render* user/assistant.
 */
const selectChain = (
  records: ReadonlyArray<Record<string, unknown>>,
): { chain: ReadonlyArray<Record<string, unknown>>; warning?: string } => {
  const byUuid = new Map<string, Record<string, unknown>>()
  for (const record of records) {
    if (record["isSidechain"]) continue
    const uuid = record["uuid"]
    if (typeof uuid === "string" && uuid) byUuid.set(uuid, record)
  }

  const parented = new Set<string>()
  for (const record of byUuid.values()) {
    const parent = parentOf(record)
    if (parent) parented.add(parent)
  }

  // Prefer a leaf that is a user/assistant turn; fall back to any unparented uuid node
  // then walk upward (through attachment/progress/etc.) until user/assistant ancestors.
  const turnLeaves = [...byUuid.values()].filter((r) => {
    const uuid = r["uuid"]
    return typeof uuid === "string" && !parented.has(uuid) && isTurnType(r["type"])
  })

  const anyLeaves = [...byUuid.values()].filter((r) => {
    const uuid = r["uuid"]
    return typeof uuid === "string" && !parented.has(uuid)
  })

  const sortByTs = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ta = typeof a["timestamp"] === "string" ? a["timestamp"] : ""
    const tb = typeof b["timestamp"] === "string" ? b["timestamp"] : ""
    return ta.localeCompare(tb)
  }

  const leaf =
    turnLeaves.sort(sortByTs).at(-1) ??
    anyLeaves.sort(sortByTs).at(-1) ??
    [...byUuid.values()].filter((r) => isTurnType(r["type"])).sort(sortByTs).at(-1)

  if (!leaf) {
    return {
      chain: records.filter((r) => isTurnType(r["type"])),
      warning: "No Claude parent-chain leaf found; using chronological transcript records.",
    }
  }

  const chain: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  let current: Record<string, unknown> | undefined = leaf
  while (current) {
    const uuid = current["uuid"]
    if (typeof uuid !== "string" || seen.has(uuid)) break
    seen.add(uuid)
    chain.push(current)
    const parent = parentOf(current)
    current = parent ? byUuid.get(parent) : undefined
  }
  chain.reverse()
  return { chain: chain.filter((r) => isTurnType(r["type"])) }
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

export const decodeClaudeFile = Effect.fn("claude.decodeFile")(function* (
  path: string,
  maxToolChars = 300,
) {
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

  const { chain, warning } = selectChain(records)
  if (warning) {
    warnings.push(new Warning({ code: "parent_chain_fallback", message: warning }))
  }

  const turns: Array<Turn> = []
  for (const record of chain) {
    const turn = renderRecord(record, maxToolChars)
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
