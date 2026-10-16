import { Effect } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { Capabilities } from "../../ir/index.js"
import { resolveSessionRef } from "../../platform/resolve.js"
import { decodeGrokSession } from "./decode.js"
import { listGrokSessions } from "./list.js"

export const grokAdapter: SessionAdapter = {
  id: "grok",
  capabilities: new Capabilities({
    format: "grok",
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
  list: (opts) => listGrokSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const sessions = yield* listGrokSessions({ cwd: opts.cwd })
      const path = yield* resolveSessionRef("grok", ref, sessions)
      return yield* decodeGrokSession(path, opts.maxToolChars ?? 300)
    }),
}
