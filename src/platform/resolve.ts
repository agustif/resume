import { Effect, FileSystem } from "effect"
import type { SessionRef } from "../ir/index.js"
import { AmbiguousRef, SessionNotFound } from "../core/errors.js"
import type { FormatId } from "../ir/formats.js"

/**
 * Resolve a free-text / id / path / "latest" ref against discovered sessions.
 */
export const resolveSessionRef = Effect.fn("platform.resolveSessionRef")(function* (
  format: FormatId,
  ref: string,
  sessions: ReadonlyArray<SessionRef>,
  opts?: { readonly pathExists?: (p: string) => Effect.Effect<boolean, never, FileSystem.FileSystem> },
) {
  const trimmed = ref.trim() || "latest"
  const fs = yield* FileSystem.FileSystem

  const looksLikePath =
    trimmed.includes("/") ||
    trimmed.endsWith(".jsonl") ||
    trimmed.endsWith(".jsonl.zst") ||
    trimmed.endsWith(".db")

  if (looksLikePath) {
    const exists = opts?.pathExists
      ? yield* opts.pathExists(trimmed)
      : yield* fs.exists(trimmed)
    if (exists) return trimmed
    return yield* new SessionNotFound({ format, reference: trimmed })
  }

  if (sessions.length === 0) {
    return yield* new SessionNotFound({ format, reference: trimmed })
  }

  if (trimmed === "latest") {
    const first = sessions[0]
    if (!first) return yield* new SessionNotFound({ format, reference: trimmed })
    return first.path
  }

  const exact = sessions.filter(
    (s) =>
      s.sessionId === trimmed ||
      s.sessionId.startsWith(trimmed) ||
      s.path.endsWith(trimmed),
  )
  if (exact.length === 1 && exact[0]) return exact[0].path
  if (exact.length > 1) {
    return yield* new AmbiguousRef({ reference: trimmed, matches: exact })
  }

  const textMatches = sessions.filter((s) => {
    const hay = `${s.title ?? ""} ${s.sessionId} ${s.path}`.toLowerCase()
    return hay.includes(trimmed.toLowerCase())
  })
  if (textMatches.length === 1 && textMatches[0]) return textMatches[0].path
  if (textMatches.length > 1) {
    return yield* new AmbiguousRef({ reference: trimmed, matches: textMatches })
  }

  return yield* new SessionNotFound({ format, reference: trimmed })
})
