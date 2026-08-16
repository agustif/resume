import { Match } from "effect"
import type { Session, Turn, Warning } from "../ir/index.js"
import {
  AssistantTurn,
  Session as SessionSchema,
  UserTurn,
  Warning as WarningSchema,
} from "../ir/index.js"

const GENERATED_META = /^\s*<[a-z][A-Za-z0-9_.:-]*(?:\s|\/?>)/
const INTERRUPTED = /^\s*\[Request interrupted by user/i
const USER_QUERY_RE = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi

/** Strip wrapper / meta user text that should never re-enter a host prompt. */
export const isGeneratedMetaText = (text: string): boolean => {
  const t = text.trim()
  if (!t) return true
  return (
    GENERATED_META.test(t) ||
    INTERRUPTED.test(t) ||
    t.startsWith("# AGENTS.md") ||
    t.includes("<INSTRUCTIONS>") ||
    t.includes("</INSTRUCTIONS>") ||
    t.startsWith("<system-reminder") ||
    t.includes("<system-reminder>") ||
    t.startsWith("<user_info>") ||
    t.includes("<user_info>") ||
    t.startsWith("<environment_context") ||
    t.startsWith("<user_instructions") ||
    t.startsWith("<manually_attached_skills")
  )
}

/** Strip Cursor/plain "USER:" prefixes that are storage artifacts, not user intent. */
export const stripUserRolePrefix = (text: string): string => {
  const stripped = text.replace(/^\s*USER:\s*/i, "").trim()
  // Drop trailing Cursor blob-id suffixes like `$44c6fb09-...`
  return stripped.replace(/\s*\$[0-9a-fA-F-]{20,}\s*$/g, "").trim()
}

/**
 * Extract recoverable user-visible text from foreign transcripts.
 * Prefer `<user_query>` bodies; drop instruction wrappers.
 */
export const extractUserText = (text: string): string | undefined => {
  const matches = [...text.matchAll(USER_QUERY_RE)]
    .map((m) => stripUserRolePrefix(m[1] ?? ""))
    .filter(Boolean)
  if (matches.length > 0) return matches.join("\n")
  if (isGeneratedMetaText(text)) return undefined
  const trimmed = stripUserRolePrefix(text)
  return trimmed || undefined
}

const sanitizeTurn = (turn: Turn): Turn | undefined =>
  Match.valueTags(turn, {
    User: (t) => {
      const text = extractUserText(t.text)
      if (!text) return undefined
      return text === t.text ? t : new UserTurn({ text, ...(t.toolResults ? { toolResults: t.toolResults } : {}) })
    },
    Assistant: (t) => {
      const text =
        t.text !== undefined && !isGeneratedMetaText(t.text) ? t.text : undefined
      if ((text === undefined || text.trim() === "") && t.toolCalls.length === 0) {
        return undefined
      }
      return new AssistantTurn({
        ...(text !== undefined ? { text } : {}),
        toolCalls: t.toolCalls,
      })
    },
    ToolResult: (t) => t,
    Boundary: (t) => t,
  })

/**
 * Safety filter on IR. Never executes foreign tools; drops generated meta text.
 */
export const sanitizeSession = (session: Session): Session => {
  const turns: Array<Turn> = []
  let dropped = 0
  for (const turn of session.turns) {
    const next = sanitizeTurn(turn)
    if (next === undefined) {
      dropped += 1
      continue
    }
    turns.push(next)
  }

  const warnings: Array<Warning> = [...session.warnings]
  if (dropped > 0) {
    warnings.push(
      new WarningSchema({
        code: "safety_dropped_turns",
        message: `Dropped ${dropped} turn(s) as generated meta or empty content.`,
      }),
    )
  }

  return new SessionSchema({
    ...session,
    turns,
    warnings,
  })
}
