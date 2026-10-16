import { Effect, Option, Schema } from "effect"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
import { DecodeFailed } from "../../core/errors.js"
import { isGeneratedMetaText } from "../../core/safety.js"
import {
  AssistantTurn,
  BoundaryTurn,
  IR_VERSION,
  Session,
  SessionId,
  SessionMeta,
  SessionSource,
  SubagentRun,
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
import { canonicalToolFor } from "../../platform/text.js"
import { decompressZstdFile } from "../../platform/zstd.js"
import {
  CodexSessionMetaPayload,
  decodeEnvelope,
  decodeSessionMeta,
} from "./wire.js"

const CODEX_ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$/

const SAFE_TOP_LEVEL = new Set(["session_meta", "response_item", "compacted", "event_msg"])
/**
 * Known-benign progress noise: snapshots, token accounts, and trigger flags.
 * Skipped silently (never counted) — they are not conversation and not threats.
 */
const SILENT_TOP_LEVEL = new Set([
  "turn_context",
  "world_state",
  "inter_agent_communication_metadata",
  "token_usage_record",
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
    const name = typeof item["name"] === "string" ? item["name"] : "function"
    const canonical = canonicalToolFor(name)
    return {
      turn: new AssistantTurn({
        toolCalls: [
          new ToolCall({
            ...(callId(item) !== undefined ? { id: callId(item) } : {}),
            name,
            ...(canonical !== undefined ? { canonical } : {}),
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
    const name = typeof item["name"] === "string" ? item["name"] : "custom_tool"
    const canonical = canonicalToolFor(name)
    return {
      turn: new AssistantTurn({
        toolCalls: [
          new ToolCall({
            ...(callId(item) !== undefined ? { id: callId(item) } : {}),
            name,
            ...(canonical !== undefined ? { canonical } : {}),
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

interface SubAgentAcc {
  readonly key: string
  description?: string | undefined
  readonly turns: Array<Turn>
}

/**
 * Text from agent-message content blocks. Accepts both `input_text` (routing
 * envelopes) and `Text` (subagent hand-backs); encrypted and reasoning
 * blocks stay out, like messageText.
 */
const agentText = (content: unknown): string => {
  const parts: Array<string> = []
  for (const block of blocks(content)) {
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
      blockType === "text" ||
      blockType === "Text"
    ) {
      const text = block["text"]
      if (typeof text === "string" && text.trim() && !isGeneratedMetaText(text)) {
        parts.push(text)
      }
    }
  }
  return parts.join("\n")
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
  const subRuns = new Map<string, SubAgentAcc>()
  let lastSubKey: string | undefined
  let lastAssistantText: string | undefined

  const openRun = (key: string, description?: string): SubAgentAcc => {
    const existing = subRuns.get(key)
    if (existing) {
      if (!existing.description && description) existing.description = description
      return existing
    }
    const run: SubAgentAcc = {
      key,
      ...(description !== undefined ? { description } : {}),
      turns: [],
    }
    subRuns.set(key, run)
    return run
  }

  const pushMain = (turn: Turn): void => {
    turns.push(turn)
    if (turn._tag === "Assistant" && turn.text?.trim()) {
      lastAssistantText = turn.text
    }
  }

  /**
   * Completed execution items (event_msg/item_completed). Shell runs and
   * extension calls become inert tool turns on the main chain; subagent
   * traffic accumulates into sidechain runs; reasoning stays dropped.
   */
  const renderCompletedItem = (
    item: Record<string, unknown>,
    turnId: string | undefined,
  ): void => {
    const kind = item["type"]
    const id = typeof item["id"] === "string" ? item["id"] : undefined

    if (kind === "CommandExecution") {
      const command = Array.isArray(item["command"])
        ? item["command"].map(String).join(" ")
        : typeof item["parsed_cmd"] === "string"
          ? item["parsed_cmd"]
          : "shell"
      const output =
        [item["stdout"], item["aggregated_output"], item["formatted_output"], item["stderr"]].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        ) ?? ""
      const exitCode = item["exit_code"]
      pushMain(
        new AssistantTurn({
          toolCalls: [
            new ToolCall({
              ...(id !== undefined ? { id } : {}),
              name: "shell",
              canonical: "shell",
              argsPreview: oneLine(command, maxToolChars),
              inert: true,
            }),
          ],
        }),
      )
      if (output || (typeof exitCode === "number" && exitCode !== 0)) {
        turns.push(
          new ToolResultTurn({
            results: [
              new ToolResult({
                ...(id !== undefined ? { callId: id } : {}),
                content: oneLine(output, maxToolChars),
                isError: typeof exitCode === "number" ? exitCode !== 0 : false,
                unavailable: false,
                inert: true,
              }),
            ],
          }),
        )
      }
      return
    }

    if (kind === "Extension") {
      const name = typeof item["kind"] === "string" && item["kind"] ? item["kind"] : "extension"
      const canonical = canonicalToolFor(name)
      pushMain(
        new AssistantTurn({
          toolCalls: [
            new ToolCall({
              ...(id !== undefined ? { id } : {}),
              name,
              ...(canonical !== undefined ? { canonical } : {}),
              argsPreview: oneLine(
                { query: item["query"] ?? null, action: item["action"] ?? null },
                maxToolChars,
              ),
              inert: true,
            }),
          ],
        }),
      )
      const snippets: Array<string> = []
      const results = item["results"]
      if (Array.isArray(results)) {
        for (const result of results) {
          if (!isRecord(result)) continue
          const snippet = result["snippet"] ?? result["title"] ?? result["url"]
          if (typeof snippet === "string" && snippet.trim()) {
            snippets.push(snippet.trim())
          }
        }
      }
      if (snippets.length > 0) {
        turns.push(
          new ToolResultTurn({
            results: [
              new ToolResult({
                ...(id !== undefined ? { callId: id } : {}),
                content: oneLine(snippets.join("\n"), maxToolChars),
                isError: false,
                unavailable: false,
                inert: true,
              }),
            ],
          }),
        )
      }
      return
    }

    if (kind === "Reasoning") {
      unsafeCount += 1
      return
    }

    if (kind === "SubAgentActivity") {
      const key =
        typeof item["agent_path"] === "string" && item["agent_path"]
          ? item["agent_path"]
          : typeof item["agent_thread_id"] === "string"
            ? item["agent_thread_id"]
            : undefined
      if (key) {
        openRun(key)
        lastSubKey = key
      }
      return
    }

    if (kind === "AgentMessage") {
      const text = agentText(item["content"])
      if (!text) return
      const key = lastSubKey ?? turnId ?? "agent"
      openRun(key).turns.push(new AssistantTurn({ text, toolCalls: [] }))
      lastSubKey = key
      return
    }

    unsafeCount += 1
  }

  const baseBefore = turns.length
  for (const item of baseItems) {
    const { turn, unsafe } = renderItem(item, maxToolChars)
    if (unsafe) unsafeCount += 1
    if (turn) pushMain(turn)
  }
  if (turns.length > baseBefore) {
    turns.push(
      new BoundaryTurn({
        kind: "compact",
        note: `recovered ${turns.length - baseBefore} pre-compaction turn(s) from replacement history`,
      }),
    )
  }

  for (const raw of records.slice(startIndex)) {
    const env = decodeEnvelope(raw)
    if (Option.isNone(env)) {
      unsafeCount += 1
      continue
    }
    const { type: recordType, payload } = env.value

    if (recordType === "response_item") {
      if (isRecord(payload) && payload["type"] === "agent_message") {
        const author = typeof payload["author"] === "string" ? payload["author"] : undefined
        const recipient =
          typeof payload["recipient"] === "string" ? payload["recipient"] : undefined
        const key =
          recipient ??
          author ??
          (typeof payload["id"] === "string" ? payload["id"] : "agent")
        const run = openRun(
          key,
          author ?? recipient ? `${author ?? "?"} → ${recipient ?? "?"}` : undefined,
        )
        lastSubKey = key
        const text = messageText(payload)
        if (text) run.turns.push(new AssistantTurn({ text, toolCalls: [] }))
      } else {
        const { turn, unsafe } = renderItem(payload, maxToolChars)
        if (unsafe) unsafeCount += 1
        if (turn) pushMain(turn)
      }
    } else if (recordType === "event_msg" && isRecord(payload)) {
      const eventType = payload["type"]
      if (eventType === "thread_rolled_back") {
        const number = payload["num_turns"]
        dropLastUserTurns(turns, typeof number === "number" ? number : 0)
        turns.push(
          new BoundaryTurn({
            kind: "rollback",
            note:
              typeof number === "number" ? `rolled back ${number} turn(s)` : "rolled back",
          }),
        )
        lastAssistantText = undefined
      } else if (eventType === "task_complete") {
        // The visible answer often lives here; skip when it duplicates the
        // last assistant text already decoded from response_items.
        const message = payload["last_agent_message"]
        if (
          typeof message === "string" &&
          message.trim() &&
          message !== lastAssistantText
        ) {
          pushMain(new AssistantTurn({ text: message, toolCalls: [] }))
        }
      } else if (eventType === "item_completed" && isRecord(payload["item"])) {
        const turnId = typeof payload["turn_id"] === "string" ? payload["turn_id"] : undefined
        renderCompletedItem(payload["item"], turnId)
      }
      // task_started, thread_settings_applied, token_count: progress noise.
    } else if (recordType === "session_meta" || recordType === "compacted") {
      continue
    } else if (SILENT_TOP_LEVEL.has(recordType)) {
      continue
    } else if (!SAFE_TOP_LEVEL.has(recordType)) {
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

  const subagents = [...subRuns.values()].map(
    (run) =>
      new SubagentRun({
        id: run.key,
        path: `${path}#${run.key}`,
        turns: run.turns,
        warnings: [],
        ...(run.description !== undefined ? { description: run.description } : {}),
      }),
  )

  return new Session({
    irVersion: IR_VERSION,
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
    ...(subagents.length > 0 ? { subagents } : {}),
  })
})
