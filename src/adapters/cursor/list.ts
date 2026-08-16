import { Clock, Effect, FileSystem, Option, Path } from "effect"
import { SessionRef } from "../../ir/index.js"
import { resolveCursorHome } from "../../platform/homes.js"
import { withinWindow } from "../../platform/text.js"

export const listCursorSessions = Effect.fn("cursor.list")(function* (opts: {
  cwd?: string | undefined
  withinMin?: number | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const home = yield* resolveCursorHome()
  const chats = pathApi.join(home, "chats")
  if (!(yield* fs.exists(chats))) return [] as ReadonlyArray<SessionRef>

  const now = yield* Clock.currentTimeMillis
  const workspaces = yield* fs
    .readDirectory(chats)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))

  const refs: Array<SessionRef> = []
  for (const ws of workspaces) {
    const wsPath = pathApi.join(chats, ws)
    const sessions = yield* fs
      .readDirectory(wsPath)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))
    for (const name of sessions) {
      const sessionDir = pathApi.join(wsPath, name)
      const store = pathApi.join(sessionDir, "store.db")
      if (!(yield* fs.exists(store))) continue
      const stat = yield* fs.stat(store).pipe(Effect.orElseSucceed(() => undefined))
      if (!stat) continue
      const mtime = Option.getOrUndefined(stat.mtime)
      const updatedAtMs = mtime ? mtime.getTime() : 0
      if (!withinWindow(updatedAtMs, opts.withinMin, now)) continue

      refs.push(
        new SessionRef({
          format: "cursor",
          sessionId: name,
          path: store,
          updatedAt: new Date(updatedAtMs).toISOString(),
          updatedAtMs,
        }),
      )
    }
  }

  // optional cwd filter is weak for cursor (hashed workspaces) — ignore unless path contains it
  void opts.cwd

  return refs.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
})
