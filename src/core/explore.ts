import { Match } from "effect"
import type { Turn } from "../ir/index.js"

export const PAGE_LIMIT_DEFAULT = 20
export const PAGE_LIMIT_MAX = 40
export const READ_CHARS_DEFAULT = 4000
export const READ_CHARS_MAX = 8000
export const LINE_WIDTH = 160

export interface ExploreWindow<T> {
  total: number
  from: number
  limit: number
  nextFrom: number | null
  clamped: boolean
  items: ReadonlyArray<T>
}

export interface AgentLine {
  id: string
  description?: string | undefined
  agentType?: string | undefined
  spawnDepth?: number | undefined
  isFork?: boolean | undefined
  turns?: number | undefined
}

const oneLine = (text: string, width: number): string => {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= width) return collapsed
  return `${collapsed.slice(0, width)}...`
}

export const clampWindow = (
  total: number,
  from: number,
  limit: number,
  maxLimit: number,
): { from: number; limit: number; clamped: boolean } => {
  const start = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0
  const requested = Number.isFinite(limit) ? Math.floor(limit) : PAGE_LIMIT_DEFAULT
  const size = Math.min(maxLimit, Math.max(1, requested))
  return { from: start, limit: size, clamped: size !== requested && requested > 0 }
}

export const windowOf = <T>(
  items: ReadonlyArray<T>,
  from: number,
  limit: number,
  maxLimit: number,
): ExploreWindow<T> => {
  const clamped = clampWindow(items.length, from, limit, maxLimit)
  const slice = items.slice(clamped.from, clamped.from + clamped.limit)
  const next = clamped.from + clamped.limit
  return {
    total: items.length,
    from: clamped.from,
    limit: clamped.limit,
    nextFrom: next < items.length ? next : null,
    clamped: clamped.clamped,
    items: slice,
  }
}

export const turnKind = (turn: Turn): "user" | "assistant" | "tool-result" | "boundary" =>
  Match.valueTags(turn, {
    User: () => "user" as const,
    Assistant: () => "assistant" as const,
    ToolResult: () => "tool-result" as const,
    Boundary: () => "boundary" as const,
  })

/** All recoverable text for one turn. Tool output is included, so this can be large. */
export const turnBody = (turn: Turn): string =>
  Match.valueTags(turn, {
    User: (t) =>
      [t.text, ...(t.toolResults ?? []).map((result) => result.content)].filter((part) => part.trim()).join("\n"),
    Assistant: (t) =>
      [t.text ?? "", ...t.toolCalls.map((call) => `${call.name} ${call.argsPreview}`)]
        .filter((part) => part.trim())
        .join("\n"),
    ToolResult: (t) => t.results.map((result) => result.content).join("\n"),
    Boundary: (t) => t.note ?? t.kind,
  })

const turnHint = (turn: Turn): string =>
  Match.valueTags(turn, {
    User: (t) => t.text,
    Assistant: (t) => {
      const tools = t.toolCalls.map((call) => call.name).join(",")
      const text = t.text?.trim() ?? ""
      if (text && tools) return `${text} tools=${tools}`
      if (tools) return `tools=${tools}`
      return text
    },
    ToolResult: (t) => {
      const ids = t.results.flatMap((result) => (result.callId ? [result.callId] : []))
      const calls = ids.length > 0 ? ` ${ids.join(",")}` : ""
      return `${t.results.length} result(s)${calls}`
    },
    Boundary: (t) => `${t.kind} ${t.note ?? ""}`.trim(),
  })

export const pageLine = (index: number, turn: Turn): string => {
  const kind = turnKind(turn).padEnd(12)
  const chars = String(turnBody(turn).length).padStart(7)
  const idx = String(index).padStart(5, "0")
  return `${idx}  ${kind}  ${chars}c  ${oneLine(turnHint(turn), LINE_WIDTH)}`
}

export const userRequestIndexes = (turns: ReadonlyArray<Turn>): ReadonlyArray<number> =>
  turns.flatMap((turn, index) => (turn._tag === "User" && turn.text.trim() ? [index] : []))

export const boundaryIndexes = (turns: ReadonlyArray<Turn>): ReadonlyArray<number> =>
  turns.flatMap((turn, index) => (turn._tag === "Boundary" ? [index] : []))

export interface TextSlice {
  total: number
  from: number
  chars: number
  nextFrom: number | null
  clamped: boolean
  text: string
}

export const sliceText = (text: string, from: number, chars: number): TextSlice => {
  const start = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0
  const requested = Number.isFinite(chars) ? Math.floor(chars) : READ_CHARS_DEFAULT
  const size = Math.min(READ_CHARS_MAX, Math.max(1, requested))
  const body = text.slice(start, start + size)
  const next = start + size
  return {
    total: text.length,
    from: start,
    chars: size,
    nextFrom: next < text.length ? next : null,
    clamped: size !== requested && requested > 0,
    text: body,
  }
}

export interface FindHit {
  index: number
  line: string
}

export const findTurns = (
  turns: ReadonlyArray<Turn>,
  query: string,
  from: number,
  limit: number,
): ExploreWindow<FindHit> => {
  const needle = query.trim().toLowerCase()
  const matches: Array<FindHit> = []
  if (needle) {
    turns.forEach((turn, index) => {
      if (turnBody(turn).toLowerCase().includes(needle)) {
        matches.push({ index, line: pageLine(index, turn) })
      }
    })
  }
  return windowOf(matches, from, limit, PAGE_LIMIT_MAX)
}

export const formatAgentLine = (agent: AgentLine): string => {
  const depth = agent.spawnDepth !== undefined ? `d${agent.spawnDepth}` : "d?"
  const fork = agent.isFork ? "fork" : "agent"
  const kind = agent.agentType ?? "agent"
  const turns = agent.turns !== undefined ? `  ${agent.turns} turns` : ""
  const desc = agent.description ?? ""
  return `${agent.id}  ${depth} ${fork} ${kind}${turns}  ${desc}`
}

export const pageFooter = (nextCommand: string | null, clampedNote: string | null): string => {
  const lines: Array<string> = []
  if (clampedNote) lines.push(clampedNote)
  if (nextCommand) lines.push(`next: ${nextCommand}`)
  else lines.push("next: (end)")
  return lines.join("\n")
}
