import type { SessionAdapter } from "../core/adapter.js"
import { claudeAdapter } from "./claude/index.js"
import { codexAdapter } from "./codex/index.js"
import { cursorAdapter } from "./cursor/index.js"
import { grokAdapter } from "./grok/index.js"
import { opencodeAdapter } from "./opencode/index.js"
import { piAdapter } from "./pi/index.js"

export const allAdapters: ReadonlyArray<SessionAdapter> = [
  claudeAdapter,
  codexAdapter,
  grokAdapter,
  cursorAdapter,
  opencodeAdapter,
  piAdapter,
]

export {
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  grokAdapter,
  opencodeAdapter,
  piAdapter,
}
