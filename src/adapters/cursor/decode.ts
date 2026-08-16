import { Effect, FileSystem, Path, Schema } from "effect"
import { DecodeFailed } from "../../core/errors.js"
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
import { contentText, isRecord, oneLine } from "../../platform/text.js"

const decodeBlobText = (data: unknown): string | undefined => {
  if (typeof data === "string") return data
  if (data instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(data)
    } catch {
      return undefined
    }
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8")
  }
  return undefined
}

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const renderJsonMessage = (
  value: Record<string, unknown>,
  maxToolChars: number,
): Turn | undefined => {
  const role = typeof value["role"] === "string" ? value["role"].toLowerCase() : ""
  if (role === "system" || role === "developer" || role === "instruction") return undefined

  if (role === "user") {
    const text = contentText(value["content"] ?? value["message"])
    const extracted = extractUserText(text)
    if (!extracted) return undefined
    return new UserTurn({ text: extracted })
  }

  if (role === "assistant") {
    const text = contentText(value["content"] ?? value["message"])
    const toolCalls: Array<ToolCall> = []
    const calls = value["tool_calls"]
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!isRecord(call)) continue
        const fn = isRecord(call["function"]) ? call["function"] : call
        toolCalls.push(
          new ToolCall({
            ...(typeof call["id"] === "string" ? { id: call["id"] } : {}),
            name: typeof fn["name"] === "string" ? fn["name"] : "tool",
            argsPreview: oneLine(fn["arguments"] ?? {}, maxToolChars),
            inert: true,
          }),
        )
      }
    }
    // content blocks
    const content = value["content"]
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block["type"] === "tool_use" || block["type"] === "tool_call") {
          toolCalls.push(
            new ToolCall({
              ...(typeof block["id"] === "string" ? { id: block["id"] } : {}),
              name: typeof block["name"] === "string" ? block["name"] : "tool",
              argsPreview: oneLine(block["input"] ?? block["arguments"] ?? {}, maxToolChars),
              inert: true,
            }),
          )
        }
      }
    }
    if ((!text || isGeneratedMetaText(text)) && toolCalls.length === 0) return undefined
    return new AssistantTurn({
      ...(text && !isGeneratedMetaText(text) ? { text } : {}),
      toolCalls,
    })
  }

  if (role === "tool") {
    return new ToolResultTurn({
      results: [
        new ToolResult({
          ...(typeof value["tool_call_id"] === "string" ? { callId: value["tool_call_id"] } : {}),
          content: oneLine(contentText(value["content"]), maxToolChars),
          isError: Boolean(value["is_error"]),
          unavailable: false,
          inert: true,
        }),
      ],
    })
  }

  return undefined
}

export const decodeCursorStore = Effect.fn("cursor.decodeStore")(function* (
  storePath: string,
  maxToolChars = 300,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  if (!(yield* fs.exists(storePath))) {
    return yield* new DecodeFailed({
      format: "cursor",
      path: storePath,
      reason: "store.db not found",
    })
  }

  const blobs = yield* querySqlite<{ id: string; data: unknown }>(
    storePath,
    "cursor",
    "SELECT id, data FROM blobs",
  )
  const metaRows = yield* querySqlite<{ key: string; value: unknown }>(
    storePath,
    "cursor",
    "SELECT key, value FROM meta",
  )

  let title: string | undefined
  for (const row of metaRows) {
    const text = decodeBlobText(row.value) ?? (typeof row.value === "string" ? row.value : undefined)
    if (!text) continue
    let parsed = tryParseJson(text)
    if (typeof parsed !== "object" && /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) {
      try {
        parsed = JSON.parse(Buffer.from(text, "hex").toString("utf8"))
      } catch {
        // ignore
      }
    }
    if (isRecord(parsed)) {
      if (typeof parsed["name"] === "string") title = parsed["name"]
      if (typeof parsed["title"] === "string") title = parsed["title"]
    }
  }

  const turns: Array<Turn> = []
  const warnings: Array<Warning> = []
  let jsonMessages = 0
  let skippedBinary = 0

  for (const blob of blobs) {
    const text = decodeBlobText(blob.data)
    if (!text) {
      skippedBinary += 1
      continue
    }
    const parsed = tryParseJson(text)
    if (!isRecord(parsed) || typeof parsed["role"] !== "string") {
      // plain USER: / " USER:" blob lines (Cursor sometimes stores these raw)
      if (/^\s*USER:/i.test(text) || text.includes("<user_query>")) {
        const extracted = extractUserText(text)
        if (extracted) turns.push(new UserTurn({ text: extracted }))
      } else {
        skippedBinary += 1
      }
      continue
    }
    const turn = renderJsonMessage(parsed, maxToolChars)
    if (turn) {
      turns.push(turn)
      jsonMessages += 1
    }
  }

  if (jsonMessages === 0) {
    warnings.push(
      new Warning({
        code: "cursor_limited_blob_parse",
        message:
          "Cursor store contained few/no JSON message blobs; protobuf transcripts may be incomplete.",
      }),
    )
  }
  if (skippedBinary > 0) {
    warnings.push(
      new Warning({
        code: "cursor_binary_blobs_skipped",
        message: `Skipped ${skippedBinary} non-JSON Cursor blob(s).`,
      }),
    )
  }

  const sessionId = pathApi.basename(pathApi.dirname(storePath))
  if (!title) {
    const firstUser = turns.find((t) => t._tag === "User")
    if (firstUser && firstUser._tag === "User") title = oneLine(firstUser.text, 200)
  }

  return new Session({
    irVersion: "0.1.0",
    id: Schema.decodeUnknownSync(SessionId)(sessionId),
    source: new SessionSource({ format: "cursor", path: storePath }),
    meta: new SessionMeta({
      ...(title !== undefined ? { title } : {}),
    }),
    turns,
    warnings,
  })
})
