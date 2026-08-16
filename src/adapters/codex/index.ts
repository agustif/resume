import { Effect, FileSystem } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { AmbiguousRef, SessionNotFound } from "../../core/errors.js"
import { Capabilities } from "../../ir/index.js"
import { decodeCodexFile } from "./decode.js"
import { listCodexSessions } from "./list.js"

const resolveRef = Effect.fn("codex.resolveRef")(function* (
  ref: string,
  opts: { cwd?: string | undefined },
) {
  const fs = yield* FileSystem.FileSystem
  const trimmed = ref.trim() || "latest"

  if (trimmed.includes("/") || trimmed.endsWith(".jsonl") || trimmed.endsWith(".jsonl.zst")) {
    const exists = yield* fs.exists(trimmed)
    if (exists) return trimmed
    return yield* new SessionNotFound({ format: "codex", reference: trimmed })
  }

  const sessions = yield* listCodexSessions({ cwd: opts.cwd })
  if (sessions.length === 0) {
    return yield* new SessionNotFound({ format: "codex", reference: trimmed })
  }

  if (trimmed === "latest") {
    const first = sessions[0]
    if (!first) {
      return yield* new SessionNotFound({ format: "codex", reference: trimmed })
    }
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

  return yield* new SessionNotFound({ format: "codex", reference: trimmed })
})

export const codexAdapter: SessionAdapter = {
  id: "codex",
  capabilities: new Capabilities({
    format: "codex",
    list: true,
    decode: true,
    handoff: true,
    transplant: false,
    fidelity: {
      list: "L0",
      decode: "L1",
      handoff: "L2",
      transplant: "none",
    },
  }),
  list: (opts) => listCodexSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const path = yield* resolveRef(ref, { cwd: opts.cwd })
      return yield* decodeCodexFile(path, opts.maxToolChars ?? 300)
    }),
}
