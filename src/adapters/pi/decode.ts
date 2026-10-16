import { Effect, Schema } from "effect"
import { DecodeFailed } from "../../core/errors.js"
import { extractUserText, isGeneratedMetaText } from "../../core/safety.js"
import {
  AssistantTurn,
  IR_VERSION,
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
import { querySqlite } from "../../platform/sqlite.js"
import { canonicalToolFor, isRecord, oneLine } from "../../platform/text.js"

const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const partText = (part: Record<string, unknown>): string => {
  if (typeof part["text"] === "string") return part["text"]
  if (isRecord(part["data"]) && typeof part["data"]["text"] === "string") {
    return part["data"]["text"]
  }
  return ""
}

export const decodePiSession = Effect.fn("pi.decodeSession")(function* (
  dbPath: string,
  sessionId: string,
  maxToolChars = 300,
) {
  const sessions = yield* querySqlite<{
    id: string
    title: string | null
    created_at: number | null
    updated_at: number | null
  }>(
    dbPath,
    "pi",
    "SELECT id, title, created_at, updated_at FROM sessions WHERE id = ?",
    [sessionId],
  )
  const sessionRow = sessions[0]

  const messages = yield* querySqlite<{
    id: string
    role: string
    parts: string
    created_at: number | null
  }>(
    dbPath,
    "pi",
    "SELECT id, role, parts, created_at FROM messages WHERE session_id = ? ORDER BY id ASC",
    [sessionId],
  )

  // Unknown session id (no session row AND no messages) is a hard failure, not an
  // empty session; a real-but-empty session still yields the warning below.
  if (sessionRow === undefined && messages.length === 0) {
    return yield* new DecodeFailed({
      format: "pi",
      path: dbPath,
      reason: `unknown session id: ${sessionId}`,
    })
  }

  const turns: Array<Turn> = []
  const warnings: Array<Warning> = []

  for (const message of messages) {
    const role = message.role
    const partsRaw = parseJson(message.parts)
    const parts = Array.isArray(partsRaw) ? partsRaw.filter(isRecord) : []

    if (role === "user") {
      const texts: Array<string> = []
      for (const part of parts) {
        if (part["type"] === "text") {
          const extracted = extractUserText(partText(part))
          if (extracted) texts.push(extracted)
        }
      }
      if (texts.length > 0) turns.push(new UserTurn({ text: texts.join("\n") }))
      continue
    }

    if (role === "assistant") {
      const texts: Array<string> = []
      const toolCalls: Array<ToolCall> = []
      const toolResults: Array<ToolResult> = []
      for (const part of parts) {
        const type = part["type"]
        if (type === "finish" || type === "reasoning") continue
        if (type === "text") {
          const t = partText(part)
          if (t && !isGeneratedMetaText(t)) texts.push(t)
        } else if (type === "tool" || type === "toolCall" || type === "functionCall") {
          const data = isRecord(part["data"]) ? part["data"] : part
          const name =
            typeof data["name"] === "string"
              ? data["name"]
              : typeof data["tool"] === "string"
                ? data["tool"]
                : "tool"
          const canonical = canonicalToolFor(name)
          toolCalls.push(
            new ToolCall({
              ...(typeof data["id"] === "string" ? { id: data["id"] } : {}),
              name,
              ...(canonical !== undefined ? { canonical } : {}),
              argsPreview: oneLine(data["arguments"] ?? data["input"] ?? {}, maxToolChars),
              inert: true,
            }),
          )
        } else if (type === "toolResult" || type === "tool_result") {
          const data = isRecord(part["data"]) ? part["data"] : part
          toolResults.push(
            new ToolResult({
              ...(typeof data["toolCallId"] === "string"
                ? { callId: data["toolCallId"] }
                : typeof data["id"] === "string"
                  ? { callId: data["id"] }
                  : {}),
              content: oneLine(data["content"] ?? data["output"] ?? data["text"] ?? "", maxToolChars),
              isError: Boolean(data["isError"] ?? data["is_error"]),
              unavailable: false,
              inert: true,
            }),
          )
        }
      }
      if (texts.length > 0 || toolCalls.length > 0) {
        turns.push(
          new AssistantTurn({
            ...(texts.length > 0 ? { text: texts.join("\n") } : {}),
            toolCalls,
          }),
        )
      }
      if (toolResults.length > 0) turns.push(new ToolResultTurn({ results: toolResults }))
    }
  }

  if (messages.length === 0) {
    warnings.push(
      new Warning({
        code: "pi_empty_session",
        message: "Pi session had no messages.",
      }),
    )
  }

  // Pi timestamps may be unix seconds
  const toIso = (n: number | null | undefined): string | undefined => {
    if (n == null) return undefined
    const ms = n < 1_000_000_000_000 ? n * 1000 : n
    return new Date(ms).toISOString()
  }

  return new Session({
    irVersion: IR_VERSION,
    id: Schema.decodeUnknownSync(SessionId)(sessionId),
    source: new SessionSource({ format: "pi", path: `${dbPath}#${sessionId}` }),
    meta: new SessionMeta({
      ...(sessionRow?.title ? { title: sessionRow.title } : {}),
      ...(toIso(sessionRow?.created_at) ? { createdAt: toIso(sessionRow?.created_at) } : {}),
      ...(toIso(sessionRow?.updated_at) ? { updatedAt: toIso(sessionRow?.updated_at) } : {}),
    }),
    turns,
    warnings,
  })
})
