import { Effect } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { Capabilities } from "../../ir/index.js"
import { resolveSessionRef } from "../../platform/resolve.js"
import { decodeClaudeFile } from "./decode.js"
import { listClaudeSessions } from "./list.js"

export const claudeAdapter: SessionAdapter = {
  id: "claude",
  capabilities: new Capabilities({
    format: "claude",
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
  list: (opts) => listClaudeSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const sessions = yield* listClaudeSessions({ cwd: opts.cwd })
      const path = yield* resolveSessionRef("claude", ref, sessions)
      return yield* decodeClaudeFile(path, opts.maxToolChars ?? 300)
    }),
}
