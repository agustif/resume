import { Clock, Effect, FileSystem } from "effect"
import { SessionRef } from "../../ir/index.js"
import { resolveOpenCodeDb } from "../../platform/homes.js"
import { querySqlite } from "../../platform/sqlite.js"
import { withinWindow } from "../../platform/text.js"

export const listOpenCodeSessions = Effect.fn("opencode.list")(function* (opts: {
  cwd?: string | undefined
  withinMin?: number | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const dbPath = yield* resolveOpenCodeDb()
  if (!(yield* fs.exists(dbPath))) return [] as ReadonlyArray<SessionRef>

  const now = yield* Clock.currentTimeMillis
  const rows = yield* querySqlite<{
    id: string
    directory: string | null
    title: string | null
    time_updated: number | null
  }>(
    dbPath,
    "opencode",
    "SELECT id, directory, title, time_updated FROM session ORDER BY time_updated DESC LIMIT 500",
  )

  const refs: Array<SessionRef> = []
  for (const row of rows) {
    const updatedAtMs = row.time_updated ?? 0
    if (!withinWindow(updatedAtMs, opts.withinMin, now)) continue
    if (opts.cwd && row.directory && row.directory !== opts.cwd) continue
    refs.push(
      new SessionRef({
        format: "opencode",
        sessionId: row.id,
        path: `${dbPath}#${row.id}`,
        ...(row.title ? { title: row.title } : {}),
        ...(row.directory ? { cwd: row.directory } : {}),
        updatedAt: new Date(updatedAtMs).toISOString(),
        updatedAtMs,
      }),
    )
  }
  return refs
})
