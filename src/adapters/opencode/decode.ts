import { Effect, Schema } from "effect"
import { extractUserText, isGeneratedMetaText } from "../../core/safety.js"
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
import { querySqlite } from "../../platform/sqlite.js"
import { isRecord, oneLine } from "../../platform/text.js"

const parseJson = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

export const decodeOpenCodeSession = Effect.fn("opencode.decodeSession")(function* (
  dbPath: string,
  sessionId: string,
  maxToolChars = 300,
) {
  const sessions = yield* querySqlite<{
    id: string
    directory: string | null
    title: string | null
    time_created: number | null
    time_updated: number | null
  }>(
    dbPath,
    "opencode",
    "SELECT id, directory, title, time_created, time_updated FROM session WHERE id = ?",
    [sessionId],
  )
  const sessionRow = sessions[0]

  const messages = yield* querySqlite<{
    id: string
    session_id: string
    time_created: number
    data: string
  }>(
    dbPath,
    "opencode",
    "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
    [sessionId],
  )

  const parts = yield* querySqlite<{
    id: string
    message_id: string
    time_created: number
    data: string
  }>(
    dbPath,
    "opencode",
    "SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC",
    [sessionId],
  )

  const partsByMessage = new Map<string, Array<Record<string, unknown>>>()
  for (const part of parts) {
    const data = parseJson(part.data)
    if (!isRecord(data)) continue
    const list = partsByMessage.get(part.message_id) ?? []
    list.push(data)
    partsByMessage.set(part.message_id, list)
  }

  const turns: Array<Turn> = []
  const warnings: Array<Warning> = []

  for (const message of messages) {
    const data = parseJson(message.data)
    const role =
      isRecord(data) && typeof data["role"] === "string" ? data["role"] : "assistant"
    const messageParts = partsByMessage.get(message.id) ?? []

    if (role === "user") {
      const texts: Array<string> = []
      for (const part of messageParts) {
        if (part["type"] === "text" && typeof part["text"] === "string") {
          const extracted = extractUserText(part["text"])
          if (extracted) texts.push(extracted)
        }
      }
      // fallback from data
      if (texts.length === 0 && isRecord(data) && typeof data["content"] === "string") {
        const extracted = extractUserText(data["content"])
        if (extracted) texts.push(extracted)
      }
      if (texts.length > 0) turns.push(new UserTurn({ text: texts.join("\n") }))
      continue
    }

    if (role === "assistant" || role === "system") {
      if (role === "system") continue
      const texts: Array<string> = []
      const toolCalls: Array<ToolCall> = []
      const toolResults: Array<ToolResult> = []
      for (const part of messageParts) {
        const type = part["type"]
        if (type === "reasoning" || type === "step-start" || type === "step-finish") continue
        if (type === "text" && typeof part["text"] === "string") {
          if (!isGeneratedMetaText(part["text"])) texts.push(part["text"])
        } else if (type === "tool") {
          const name = typeof part["tool"] === "string" ? part["tool"] : "tool"
          const callId = typeof part["callID"] === "string" ? part["callID"] : undefined
          const state = isRecord(part["state"]) ? part["state"] : {}
          toolCalls.push(
            new ToolCall({
              ...(callId !== undefined ? { id: callId } : {}),
              name,
              argsPreview: oneLine(state["input"] ?? {}, maxToolChars),
              inert: true,
            }),
          )
          if (state["status"] === "completed" || state["output"] !== undefined) {
            toolResults.push(
              new ToolResult({
                ...(callId !== undefined ? { callId } : {}),
                content: oneLine(state["output"] ?? state["error"] ?? "ok", maxToolChars),
                isError: state["status"] === "error",
                unavailable: false,
                inert: true,
              }),
            )
          }
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
      if (toolResults.length > 0) {
        turns.push(new ToolResultTurn({ results: toolResults }))
      }
    }
  }

  if (messages.length === 0) {
    warnings.push(
      new Warning({
        code: "opencode_empty_session",
        message: "OpenCode session had no messages.",
      }),
    )
  }

  const title = sessionRow?.title ?? undefined
  const cwd = sessionRow?.directory ?? undefined
  const createdAt =
    sessionRow?.time_created != null
      ? new Date(sessionRow.time_created).toISOString()
      : undefined
  const updatedAt =
    sessionRow?.time_updated != null
      ? new Date(sessionRow.time_updated).toISOString()
      : undefined

  return new Session({
    irVersion: "0.1.0",
    id: Schema.decodeUnknownSync(SessionId)(sessionId),
    source: new SessionSource({ format: "opencode", path: `${dbPath}#${sessionId}` }),
    meta: new SessionMeta({
      ...(title ? { title } : {}),
      ...(cwd ? { cwd } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }),
    turns,
    warnings,
  })
})
