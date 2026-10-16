import { Effect } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { Capabilities, Session } from "../../ir/index.js"
import { resolveSessionRef } from "../../platform/resolve.js"
import { decodeClaudeFile } from "./decode.js"
import { listClaudeSessions } from "./list.js"
import { loadClaudeSubagents } from "./subagents.js"

export const claudeAdapter: SessionAdapter = {
  id: "claude",
  capabilities: new Capabilities({
    format: "claude",
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
  list: (opts) => listClaudeSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const sessions = yield* listClaudeSessions({ cwd: opts.cwd })
      const path = yield* resolveSessionRef("claude", ref, sessions)
      // 0 keeps full tool args and results. Callers can still pass a cap.
      const maxToolChars = opts.maxToolChars ?? 0
      const session = yield* decodeClaudeFile(path, maxToolChars)
      const subagents = yield* loadClaudeSubagents(path, maxToolChars)
      if (subagents.length === 0) return session
      return new Session({
        irVersion: session.irVersion,
        id: session.id,
        source: session.source,
        meta: session.meta,
        turns: session.turns,
        warnings: session.warnings,
        subagents,
      })
    }),
}
