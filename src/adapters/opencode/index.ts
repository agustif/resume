import { Effect } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { SessionNotFound } from "../../core/errors.js"
import { Capabilities } from "../../ir/index.js"
import { resolveOpenCodeDb } from "../../platform/homes.js"
import { decodeOpenCodeSession } from "./decode.js"
import { listOpenCodeSessions } from "./list.js"

const parseRef = (ref: string): { dbPath?: string; sessionId: string } => {
  const trimmed = ref.trim() || "latest"
  const hash = trimmed.lastIndexOf("#")
  if (hash >= 0) {
    return { dbPath: trimmed.slice(0, hash), sessionId: trimmed.slice(hash + 1) }
  }
  return { sessionId: trimmed }
}

export const opencodeAdapter: SessionAdapter = {
  id: "opencode",
  capabilities: new Capabilities({
    format: "opencode",
    list: true,
    decode: true,
    handoff: true,
    transplant: true,
    fidelity: {
      list: "L0",
      decode: "L1",
      handoff: "L2",
      transplant: "L3",
    },
  }),
  list: (opts) => listOpenCodeSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const sessions = yield* listOpenCodeSessions({ cwd: opts.cwd })
      const parsed = parseRef(ref)
      let sessionId = parsed.sessionId
      let dbPath = parsed.dbPath ?? (yield* resolveOpenCodeDb())

      if (sessionId === "latest") {
        const first = sessions[0]
        if (!first) {
          return yield* new SessionNotFound({ format: "opencode", reference: ref })
        }
        const p = parseRef(first.path)
        sessionId = p.sessionId
        dbPath = p.dbPath ?? dbPath
      } else {
        const match = sessions.find(
          (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
        )
        if (!match && !parsed.dbPath) {
          // allow direct id even if list filtered
        } else if (match) {
          const p = parseRef(match.path)
          sessionId = p.sessionId
          dbPath = p.dbPath ?? dbPath
        }
      }

      return yield* decodeOpenCodeSession(dbPath, sessionId, opts.maxToolChars ?? 300)
    }),
}
