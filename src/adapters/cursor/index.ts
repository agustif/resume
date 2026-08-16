import { Effect } from "effect"
import type { SessionAdapter } from "../../core/adapter.js"
import { Capabilities } from "../../ir/index.js"
import { resolveSessionRef } from "../../platform/resolve.js"
import { decodeCursorStore } from "./decode.js"
import { listCursorSessions } from "./list.js"

export const cursorAdapter: SessionAdapter = {
  id: "cursor",
  capabilities: new Capabilities({
    format: "cursor",
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
  list: (opts) => listCursorSessions(opts),
  decode: (ref, opts) =>
    Effect.gen(function* () {
      const sessions = yield* listCursorSessions({ cwd: opts.cwd })
      const path = yield* resolveSessionRef("cursor", ref, sessions)
      return yield* decodeCursorStore(path, opts.maxToolChars ?? 300)
    }),
}
