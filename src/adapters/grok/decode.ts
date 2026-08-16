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
import { readJsonlRecords } from "../../platform/jsonl.js"
import { contentText, isRecord, oneLine } from "../../platform/text.js"

const renderGrokRecord = (
  record: Record<string, unknown>,
  maxToolChars: number,
): Turn | undefined => {
  const type = record["type"]
  if (type === "system" || type === "reasoning") return undefined

  if (type === "user") {
    const content = record["content"]
    const text = typeof content === "string" ? content : contentText(content)
    const extracted = extractUserText(text)
    if (!extracted) return undefined
    return new UserTurn({ text: extracted })
  }

  if (type === "assistant") {
    const content = record["content"]
    const text = typeof content === "string" ? content : contentText(content)
    const toolCalls: Array<ToolCall> = []
    const calls = record["tool_calls"]
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (!isRecord(call)) continue
        const fn = isRecord(call["function"]) ? call["function"] : call
        toolCalls.push(
          new ToolCall({
            ...(typeof call["id"] === "string" ? { id: call["id"] } : {}),
            name:
              typeof fn["name"] === "string"
                ? fn["name"]
                : typeof call["name"] === "string"
                  ? call["name"]
                  : "tool",
            argsPreview: oneLine(fn["arguments"] ?? call["input"] ?? {}, maxToolChars),
            inert: true,
          }),
        )
      }
    }
    if ((!text || isGeneratedMetaText(text)) && toolCalls.length === 0) return undefined
    return new AssistantTurn({
      ...(text && !isGeneratedMetaText(text) ? { text } : {}),
      toolCalls,
    })
  }

  if (type === "tool_result" || type === "tool" || type === "function_call_output") {
    const content = record["content"] ?? record["output"]
    return new ToolResultTurn({
      results: [
        new ToolResult({
          ...(typeof record["tool_call_id"] === "string"
            ? { callId: record["tool_call_id"] }
            : typeof record["id"] === "string"
              ? { callId: record["id"] }
              : {}),
          content: oneLine(contentText(content) || content, maxToolChars),
          isError: Boolean(record["is_error"] ?? record["isError"]),
          unavailable: false,
          inert: true,
        }),
      ],
    })
  }

  if (type === "function_call" || type === "tool_use") {
    return new AssistantTurn({
      toolCalls: [
        new ToolCall({
          ...(typeof record["id"] === "string" ? { id: record["id"] } : {}),
          name: typeof record["name"] === "string" ? record["name"] : "tool",
          argsPreview: oneLine(record["input"] ?? record["arguments"] ?? {}, maxToolChars),
          inert: true,
        }),
      ],
    })
  }

  return undefined
}

export const decodeGrokSession = Effect.fn("grok.decodeSession")(function* (
  sessionDir: string,
  maxToolChars = 300,
) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const historyPath = pathApi.join(sessionDir, "chat_history.jsonl")
  const summaryPath = pathApi.join(sessionDir, "summary.json")

  if (!(yield* fs.exists(historyPath))) {
    return yield* new DecodeFailed({
      format: "grok",
      path: sessionDir,
      reason: "missing chat_history.jsonl",
    })
  }

  const { records, malformed } = yield* readJsonlRecords(historyPath, "grok")
  const warnings: Array<Warning> = []
  if (malformed > 0) {
    warnings.push(
      new Warning({
        code: "malformed_records_skipped",
        message: `Skipped ${malformed} malformed Grok transcript record(s).`,
      }),
    )
  }

  const turns: Array<Turn> = []
  for (const record of records) {
    const turn = renderGrokRecord(record, maxToolChars)
    if (turn) turns.push(turn)
  }

  let title: string | undefined
  let cwd: string | undefined
  if (yield* fs.exists(summaryPath)) {
    const raw = yield* fs.readFileString(summaryPath).pipe(Effect.orElseSucceed(() => ""))
    try {
      const summary = JSON.parse(raw) as Record<string, unknown>
      if (typeof summary["title"] === "string") title = summary["title"]
      if (typeof summary["cwd"] === "string") cwd = summary["cwd"]
      if (typeof summary["workspace"] === "string" && !cwd) cwd = summary["workspace"]
    } catch {
      // ignore
    }
  }

  if (!title) {
    const firstUser = turns.find((t) => t._tag === "User")
    if (firstUser && firstUser._tag === "User") title = oneLine(firstUser.text, 200)
  }

  const sessionId = pathApi.basename(sessionDir)

  return new Session({
    irVersion: "0.1.0",
    id: Schema.decodeUnknownSync(SessionId)(sessionId),
    source: new SessionSource({ format: "grok", path: sessionDir }),
    meta: new SessionMeta({
      ...(title !== undefined ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    }),
    turns,
    warnings,
  })
})
