import { Clock, Effect, FileSystem, Option, Path } from "effect"
import { SessionRef } from "../../ir/index.js"
import { resolveClaudeHome } from "../../platform/homes.js"
import { withinWindow } from "../../platform/text.js"

const walkJsonl = (
  dir: string,
  depth: number,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (depth > 6) return []
    const fs = yield* FileSystem.FileSystem
    const pathApi = yield* Path.Path
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>))
    const nested = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          // skip subagents deep trees for listing speed
          if (name === "subagents" || name === "tool-results") return [] as ReadonlyArray<string>
          const full = pathApi.join(dir, name)
          const stat = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))
          if (!stat) return []
          if (stat.type === "Directory") return yield* walkJsonl(full, depth + 1)
          if (stat.type === "File" && name.endsWith(".jsonl")) return [full]
          return []
        }),
      { concurrency: 8 },
    )
    return nested.flat()
  })

export const listClaudeSessions = Effect.fn("claude.list")(function* (opts: {
  cwd?: string | undefined
  withinMin?: number | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const home = yield* resolveClaudeHome()
  const projects = pathApi.join(home, "projects")
  if (!(yield* fs.exists(projects))) return [] as ReadonlyArray<SessionRef>

  const paths = yield* walkJsonl(projects, 0)
  const now = yield* Clock.currentTimeMillis
  const cwdSlug = opts.cwd
    ? opts.cwd.replace(/[^A-Za-z0-9]/g, "-")
    : undefined

  const refs = yield* Effect.forEach(
    paths,
    (path) =>
      Effect.gen(function* () {
        if (cwdSlug && !path.includes(cwdSlug) && !path.includes(opts.cwd ?? "\0")) {
          // soft filter by project dir slug
          const parent = pathApi.dirname(path)
          if (!parent.includes(cwdSlug)) return Option.none<SessionRef>()
        }
        const stat = yield* fs.stat(path).pipe(Effect.orElseSucceed(() => undefined))
        if (!stat) return Option.none<SessionRef>()
        const mtime = Option.getOrUndefined(stat.mtime)
        const updatedAtMs = mtime ? mtime.getTime() : 0
        if (!withinWindow(updatedAtMs, opts.withinMin, now)) return Option.none<SessionRef>()
        const sessionId = pathApi.basename(path).replace(/\.jsonl$/, "")
        return Option.some(
          new SessionRef({
            format: "claude",
            sessionId,
            path,
            updatedAt: new Date(updatedAtMs).toISOString(),
            updatedAtMs,
          }),
        )
      }),
    { concurrency: 16 },
  )

  return refs
    .flatMap((r) => (Option.isSome(r) ? [r.value] : []))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
})
