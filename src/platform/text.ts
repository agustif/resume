/** Shared text helpers for adapters. */
import type { CanonicalTool } from "../ir/session.js"

const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "local_shell",
  "terminal",
  "exec",
  "run_command",
  "command",
  "powershell",
  "zsh",
  "sh",
])

const READ_TOOLS = new Set(["read", "cat", "view", "open", "show_file"])

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "create",
  "apply_patch",
  "str_replace",
  "file_write",
])

const SEARCH_TOOLS = new Set(["grep", "glob", "search", "find", "rg", "code_search"])

/**
 * Map a foreign tool name to its canonical family, case-insensitively.
 * Names prefixed `mcp__` / `mcp-` are MCP tools. Returns `undefined` when no
 * family matches; adapters then leave `canonical` unset.
 */
export const canonicalToolFor = (name: string): CanonicalTool | undefined => {
  const normalized = name.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized.startsWith("mcp__") || normalized.startsWith("mcp-")) return "mcp"
  if (SHELL_TOOLS.has(normalized)) return "shell"
  if (READ_TOOLS.has(normalized)) return "read"
  if (EDIT_TOOLS.has(normalized)) return "edit"
  if (SEARCH_TOOLS.has(normalized)) return "search"
  return undefined
}

export const oneLine = (value: unknown, limit: number): string => {
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

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: Array<string> = []
    for (const item of content) {
      if (typeof item === "string") parts.push(item)
      else if (isRecord(item)) {
        const text = item["text"]
        if (typeof text === "string") parts.push(text)
        else if (isRecord(item["data"]) && typeof item["data"]["text"] === "string") {
          parts.push(item["data"]["text"])
        }
      }
    }
    return parts.join("\n")
  }
  if (isRecord(content)) {
    for (const key of ["text", "output", "content", "body"] as const) {
      const v = content[key]
      if (typeof v === "string") return v
    }
  }
  return ""
}

export const withinWindow = (
  updatedAtMs: number,
  withinMin: number | undefined,
  now: number,
): boolean => {
  if (withinMin === undefined || withinMin <= 0) return true
  return now - updatedAtMs >= 0 && now - updatedAtMs <= withinMin * 60 * 1000
}
