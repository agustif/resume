import { Effect, Option, Schema } from "effect"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
import { DecodeFailed } from "../../core/errors.js"
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
import {
  parseNdjsonText,
  readJsonlRecords,
} from "../../platform/jsonl.js"
import { decompressZstdFile } from "../../platform/zstd.js"
import {
  CodexSessionMetaPayload,
  decodeEnvelope,
  decodeSessionMeta,
} from "./wire.js"

const CODEX_ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$/

const SAFE_TOP_LEVEL = new Set(["session_meta", "response_item", "compacted", "event_msg"])
const IGNORED_TOP_LEVEL = new Set([
  "turn_context",
  "world_state",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
])

const oneLine = (value: unknown, limit: number): string => {
  let raw: string
  if (typeof value === "string") {
    raw = value
  } else {
    try {
      raw = JSON.stringify(value)
    } catch {
      raw = String(value)
    }
  }
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (collapsed.length <= limit) return collapsed
  return `${collapsed.slice(0, limit)}...`
}

const blocks = (content: unknown): ReadonlyArray<Record<string, unknown>> => {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) {
    return content.filter(isRecord)
  }
  if (isRecord(content)) return [content]
  return []
}

const messageText = (item: Record<string, unknown>): string => {
  const parts: Array<string> = []
  for (const block of blocks(item["content"])) {
    const blockType = block["type"]
    if (
      blockType === "reasoning" ||
      blockType === "thinking" ||
      blockType === "encrypted_content"
    ) {
      continue
    }
    if (
      blockType === "input_text" ||
      blockType === "output_text" ||
      blockType === "text"
    ) {
      const text = block["text"]
      if (typeof text === "string" && text.trim() && !isGeneratedMetaText(text)) {
        parts.push(text)
      }
    }
  }
  return parts.join("\n")
}

const callId = (rec: Record<string, unknown>): string | undefined => {
  if (typeof rec["call_id"] === "string") return rec["call_id"]
  if (typeof rec["id"] === "string") return rec["id"]
  return undefined
}

const renderItem = (
  item: unknown,
  maxToolChars: number,
): { turn: Turn | undefined; unsafe: boolean } => {
  if (!isRecord(item)) return { turn: undefined, unsafe: true }
  const itemType = item["type"]

  if (itemType === "message") {
    const role = item["role"]
    if (role !== "user" && role !== "assistant") {
      return { turn: undefined, unsafe: role === "system" || role === "developer" }
    }
    const text = messageText(item)
    if (!text) return { turn: undefined, unsafe: false }
    if (role === "user") return { turn: new UserTurn({ text }), unsafe: false }
    return { turn: new AssistantTurn({ text, toolCalls: [] }), unsafe: false }
  }

  if (itemType === "function_call") {
    return {
      turn: new AssistantTurn({
        toolCalls: [
          new ToolCall({
            ...(callId(item) !== undefined ? { id: callId(item) } : {}),
            name: typeof item["name"] === "string" ? item["name"] : "function",
            argsPreview: oneLine(item["arguments"] ?? "", maxToolChars),
            inert: true,
          }),
        ],
      }),
      unsafe: false,
    }
  }

  if (itemType === "local_shell_call") {
    return {
      turn: new AssistantTurn({
        toolCalls: [
          new ToolCall({
            ...(callId(item) !== undefined ? { id: callId(item) } : {}),
            name: "local_shell",
            canonical: "shell",
            argsPreview: oneLine(item["action"] ?? {}, maxToolChars),
            inert: true,
          }),
        ],
      }),
      unsafe: false,
    }
  }

  if (itemType === "custom_tool_call") {
    return {
      turn: new AssistantTurn({
        toolCalls: [
          new ToolCall({
            ...(callId(item) !== undefined ? { id: callId(item) } : {}),
            name: typeof item["name"] === "string" ? item["name"] : "custom_tool",
            argsPreview: oneLine(item["input"] ?? "", maxToolChars),
            inert: true,
          }),
        ],
      }),
      unsafe: false,
    }
  }

  if (itemType === "function_call_output" || itemType === "custom_tool_call_output") {
    let output: unknown = item["output"]
    if (isRecord(output)) {
      output = output["body"] ?? output["text"] ?? output
    }
    return {
      turn: new ToolResultTurn({
        results: [
          new ToolResult({
            ...(callId(item) !== undefined ? { callId: callId(item) } : {}),
            content: oneLine(output, maxToolChars),
            isError: item["success"] === false,
            unavailable: false,
            inert: true,
          }),
        ],
      }),
      unsafe: false,
    }
  }

  if (
    itemType === "reasoning" ||
    itemType === "world_state" ||
    itemType === "environment_context" ||
    itemType === "user_instructions" ||
    itemType === "computer_initialize_state"
  ) {
    return { turn: undefined, unsafe: true }
  }

  return { turn: undefined, unsafe: true }
}

const dropLastUserTurns = (turns: Array<Turn>, number: number): void => {
  if (number <= 0) return
  const positions: Array<number> = []
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]?._tag === "User") positions.push(i)
  }
  if (positions.length === 0) {
    turns.length = 0
    return
  }
  const cut = positions[Math.max(0, positions.length - number)] ?? 0
  turns.splice(cut)
}

const sessionIdFromPath = (path: string): string => {
  const base = path.split(/[/\\]/).pop() ?? path
  const match = CODEX_ROLLOUT_RE.exec(base)
  if (match?.[1]) return match[1]
  return base.replace(/\.jsonl(?:\.zst)?$/, "")
}

const loadRecords = Effect.fn("codex.loadRecords")(function* (path: string) {
  if (path.endsWith(".jsonl.zst")) {
    const text = yield* decompressZstdFile(path, "codex")
    return yield* parseNdjsonText(text, "codex", path)
  }
  if (!path.endsWith(".jsonl") && !path.includes("rollout-")) {
    return yield* new DecodeFailed({
      format: "codex",
      path,
      reason: "expected a Codex rollout .jsonl or .jsonl.zst file",
    })
  }
  return yield* readJsonlRecords(path, "codex")
})

export const decodeCodexFile = Effect.fn("codex.decodeFile")(function* (
  path: string,
  maxToolChars = 300,
) {
  const { records, malformed } = yield* loadRecords(path)
  const warnings: Array<Warning> = []

  if (malformed > 0) {
    warnings.push(
      new Warning({
        code: "malformed_records_skipped",
        message: `Skipped ${malformed} malformed Codex rollout record(s).`,
      }),
    )
  }

  const firstMeta = records
    .map((r) => decodeEnvelope(r))
    .find((e) => Option.isSome(e) && e.value.type === "session_meta")

  const metaPayload: CodexSessionMetaPayload = Option.match(
    firstMeta ?? Option.none(),
    {
      onNone: () => new CodexSessionMetaPayload({}),
      onSome: (env) =>
        Option.getOrElse(decodeSessionMeta(env.payload ?? {}), () =>
          new CodexSessionMetaPayload({}),
        ),
    },
  )

  // Compacted replacement history base
  let baseItems: Array<unknown> = []
  let startIndex = 0
  for (let index = 0; index < records.length; index++) {
    const env = decodeEnvelope(records[index] ?? {})
    if (Option.isNone(env) || env.value.type !== "compacted") continue
    const payload = env.value.payload
    if (isRecord(payload) && Array.isArray(payload["replacement_history"])) {
      baseItems = payload["replacement_history"]
      startIndex = index + 1
    }
  }

  const turns: Array<Turn> = []
  let unsafeCount = 0

  for (const item of baseItems) {
    const { turn, unsafe } = renderItem(item, maxToolChars)
    if (unsafe) unsafeCount += 1
    if (turn) turns.push(turn)
  }

  for (const raw of records.slice(startIndex)) {
    const env = decodeEnvelope(raw)
    if (Option.isNone(env)) {
      unsafeCount += 1
      continue
    }
    const { type: recordType, payload } = env.value

    if (recordType === "response_item") {
      const { turn, unsafe } = renderItem(payload, maxToolChars)
      if (unsafe) unsafeCount += 1
      if (turn) turns.push(turn)
    } else if (
      recordType === "event_msg" &&
      isRecord(payload) &&
      payload["type"] === "thread_rolled_back"
    ) {
      const number = payload["num_turns"]
      dropLastUserTurns(turns, typeof number === "number" ? number : 0)
    } else if (recordType === "session_meta" || recordType === "compacted") {
      continue
    } else if (IGNORED_TOP_LEVEL.has(recordType) || !SAFE_TOP_LEVEL.has(recordType)) {
      unsafeCount += 1
    }
  }

  if (unsafeCount > 0) {
    warnings.push(
      new Warning({
        code: "unsafe_records_skipped",
        message: `Skipped ${unsafeCount} foreign instruction, reasoning, context, or unknown Codex item(s).`,
      }),
    )
  }

  const metaId = metaPayload.id
  const sessionId = metaId ?? sessionIdFromPath(path)
  const branch = metaPayload.git?.branch ?? metaPayload.git_branch
  const cwd = metaPayload.cwd
  const formatVersion = metaPayload.cli_version

  const timestamps = records
    .map((r) => decodeEnvelope(r))
    .flatMap((e) =>
      Option.isSome(e) && e.value.timestamp !== undefined ? [e.value.timestamp] : [],
    )

  const firstUser = turns.find((t) => t._tag === "User" && t.text.trim())
  const title =
    firstUser && firstUser._tag === "User" ? oneLine(firstUser.text, 200) : undefined

  return new Session({
    irVersion: "0.1.0",
    id: Schema.decodeUnknownSync(SessionId)(sessionId),
    source: new SessionSource({
      format: "codex",
      path,
      ...(formatVersion !== undefined ? { formatVersion } : {}),
    }),
    meta: new SessionMeta({
      ...(title !== undefined ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(timestamps[0] !== undefined ? { createdAt: timestamps[0] } : {}),
      ...(timestamps[timestamps.length - 1] !== undefined
        ? { updatedAt: timestamps[timestamps.length - 1] }
        : {}),
    }),
    turns,
    warnings,
  })
})
