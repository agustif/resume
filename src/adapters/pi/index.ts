import { Effect } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { SessionNotFound } from "../../core/errors.js"
import { Capabilities } from "../../ir/index.js"
import { resolvePiDb } from "../../platform/homes.js"
import { decodePiSession } from "./decode.js"
import { listPiSessions } from "./list.js"

const parseRef = (ref: string): { dbPath?: string; sessionId: string } => {
  const trimmed = ref.trim() || "latest"
  const hash = trimmed.lastIndexOf("#")
  if (hash >= 0) {
    return { dbPath: trimmed.slice(0, hash), sessionId: trimmed.slice(hash + 1) }
  }
  return { sessionId: trimmed }
}

export const piAdapter: SessionAdapter = {
  id: "pi",
  capabilities: new Capabilities({
    format: "pi",
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
  list: (opts) => listPiSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const sessions = yield* listPiSessions({ cwd: opts.cwd })
      const parsed = parseRef(ref)
      let sessionId = parsed.sessionId
      let dbPath = parsed.dbPath ?? (yield* resolvePiDb())

      if (sessionId === "latest") {
        const first = sessions[0]
        if (!first) {
          return yield* new SessionNotFound({ format: "pi", reference: ref })
        }
        const p = parseRef(first.path)
        sessionId = p.sessionId
        dbPath = p.dbPath ?? dbPath
      } else {
        const match = sessions.find(
          (s) => s.sessionId === sessionId || s.sessionId.startsWith(sessionId),
        )
        if (match) {
          const p = parseRef(match.path)
          sessionId = p.sessionId
          dbPath = p.dbPath ?? dbPath
        }
      }

      return yield* decodePiSession(dbPath, sessionId, opts.maxToolChars ?? 300)
    }),
}
