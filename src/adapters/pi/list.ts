import { Clock, Effect, FileSystem } from "effect"
import { SessionRef } from "../../ir/index.js"
import { resolvePiDb } from "../../platform/homes.js"
import { querySqlite } from "../../platform/sqlite.js"
import { withinWindow } from "../../platform/text.js"

export const listPiSessions = Effect.fn("pi.list")(function* (opts: {
  cwd?: string | undefined
  withinMin?: number | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const dbPath = yield* resolvePiDb()
  if (!(yield* fs.exists(dbPath))) return [] as ReadonlyArray<SessionRef>

  void opts.cwd // pi schema has no cwd column in sessions table
  const now = yield* Clock.currentTimeMillis
  const rows = yield* querySqlite<{
    id: string
    title: string | null
    updated_at: number | null
  }>(
    dbPath,
    "pi",
    "SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 500",
  )

  const refs: Array<SessionRef> = []
  for (const row of rows) {
    const raw = row.updated_at ?? 0
    const updatedAtMs = raw < 1_000_000_000_000 ? raw * 1000 : raw
    if (!withinWindow(updatedAtMs, opts.withinMin, now)) continue
    refs.push(
      new SessionRef({
        format: "pi",
        sessionId: row.id,
        path: `${dbPath}#${row.id}`,
        ...(row.title ? { title: row.title } : {}),
        updatedAt: new Date(updatedAtMs).toISOString(),
        updatedAtMs,
      }),
    )
  }
  return refs
})
