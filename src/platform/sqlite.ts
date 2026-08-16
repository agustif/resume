import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { DecodeFailed } from "../core/errors.js"
import type { FormatId } from "../ir/formats.js"

export interface SqliteRow {
  readonly [column: string]: unknown
}

/**
 * Open a SQLite database read-only and run a query.
 * Uses Node's built-in `node:sqlite` (no native deps).
 */
export const querySqlite = Effect.fn("platform.querySqlite")(function* <T extends SqliteRow>(
  path: string,
  format: FormatId,
  sql: string,
  params: ReadonlyArray<string | number | null> = [],
) {
  return yield* Effect.try({
    try: () => {
      const db = new DatabaseSync(path, { readOnly: true })
      try {
        const stmt = db.prepare(sql)
        return stmt.all(...params) as Array<T>
      } finally {
        db.close()
      }
    },
    catch: (cause) =>
      new DecodeFailed({
        format,
        path,
        reason: `sqlite query failed: ${String(cause)}`,
      }),
  })
})

export const querySqliteOne = Effect.fn("platform.querySqliteOne")(function* <T extends SqliteRow>(
  path: string,
  format: FormatId,
  sql: string,
  params: ReadonlyArray<string | number | null> = [],
) {
  const rows = yield* querySqlite<T>(path, format, sql, params)
  return rows[0]
})
