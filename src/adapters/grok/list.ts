import { Clock, Effect, FileSystem, Option, Path } from "effect"
import { SessionRef } from "../../ir/index.js"
import { resolveGrokHome } from "../../platform/homes.js"
import { withinWindow } from "../../platform/text.js"

export const listGrokSessions = Effect.fn("grok.list")(function* (opts: {
  cwd?: string | undefined
  withinMin?: number | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const home = yield* resolveGrokHome()
  const sessionsRoot = pathApi.join(home, "sessions")
  if (!(yield* fs.exists(sessionsRoot))) return [] as ReadonlyArray<SessionRef>

  const now = yield* Clock.currentTimeMillis
  const cwdEnc = opts.cwd ? encodeURIComponent(opts.cwd) : undefined
  const workspaceDirs = yield* fs
    .readDirectory(sessionsRoot)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))

  const refs: Array<SessionRef> = []
  for (const ws of workspaceDirs) {
    if (cwdEnc && ws !== cwdEnc && !ws.includes(cwdEnc)) continue
    const wsPath = pathApi.join(sessionsRoot, ws)
    const stat = yield* fs.stat(wsPath).pipe(Effect.orElseSucceed(() => undefined))
    if (!stat || stat.type !== "Directory") continue

    const children = yield* fs
      .readDirectory(wsPath)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const name of children) {
      const sessionDir = pathApi.join(wsPath, name)
      const sstat = yield* fs.stat(sessionDir).pipe(Effect.orElseSucceed(() => undefined))
      if (!sstat || sstat.type !== "Directory") continue
      const history = pathApi.join(sessionDir, "chat_history.jsonl")
      if (!(yield* fs.exists(history))) continue
      const hstat = yield* fs.stat(history).pipe(Effect.orElseSucceed(() => undefined))
      const mtime = hstat ? Option.getOrUndefined(hstat.mtime) : undefined
      const updatedAtMs = mtime ? mtime.getTime() : 0
      if (!withinWindow(updatedAtMs, opts.withinMin, now)) continue

      let title: string | undefined
      const summaryPath = pathApi.join(sessionDir, "summary.json")
      if (yield* fs.exists(summaryPath)) {
        const raw = yield* fs.readFileString(summaryPath).pipe(Effect.orElseSucceed(() => ""))
        try {
          const summary = JSON.parse(raw) as Record<string, unknown>
          if (typeof summary["title"] === "string") title = summary["title"]
        } catch {
          // ignore
        }
      }

      let cwd: string | undefined
      try {
        cwd = decodeURIComponent(ws)
      } catch {
        cwd = ws
      }

      refs.push(
        new SessionRef({
          format: "grok",
          sessionId: name,
          path: sessionDir,
          ...(title !== undefined ? { title } : {}),
          ...(cwd !== undefined ? { cwd } : {}),
          updatedAt: new Date(updatedAtMs).toISOString(),
          updatedAtMs,
        }),
      )
    }
  }

  return refs.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
})
