import { Clock, Effect, FileSystem, Option, Path, Stream } from "effect"
import { SessionRef } from "../../ir/index.js"
import { resolveCodexHome } from "../../platform/homes.js"
import { isGeneratedMetaText } from "../../core/safety.js"
import { withinWindow } from "../../platform/text.js"

const CODEX_ROLLOUT_RE =
  /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-fA-F-]{36})\.jsonl(?:\.zst)?$/

/** Cap title peeks so multi-k session trees stay usable. */
const TITLE_PEEK_LIMIT = 80

const walkRollouts = (
  dir: string,
  depth: number,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (depth > 8) return [] as ReadonlyArray<string>
    const fs = yield* FileSystem.FileSystem
    const pathApi = yield* Path.Path
    const names = yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))

    const nested = yield* Effect.forEach(
      names,
      (name) =>
        Effect.gen(function* () {
          const full = pathApi.join(dir, name)
          const stat = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))
          if (!stat) return [] as ReadonlyArray<string>
          if (stat.type === "Directory") {
            return yield* walkRollouts(full, depth + 1)
          }
          if (
            stat.type === "File" &&
            CODEX_ROLLOUT_RE.test(name)
          ) {
            return [full] as ReadonlyArray<string>
          }
          return [] as ReadonlyArray<string>
        }),
      { concurrency: 16 },
    )

    return nested.flat()
  })

export interface CodexHeader {
  readonly cwd: string | undefined
  readonly title: string | undefined
}

/**
 * Single header probe: one bounded stream read returning both the rollout
 * cwd (session_meta) and a title (first real user message). Callers pick the
 * line budget: 20 for cwd filtering, 80 for titles.
 */
const headerProbe = (
  path: string,
  maxLines: number,
): Effect.Effect<CodexHeader, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const lines = yield* fs.stream(path).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.take(maxLines),
      Stream.runCollect,
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    )

    let cwd: string | undefined
    let title: string | undefined
    for (const line of lines) {
      if (!line.trim()) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (rec["type"] === "session_meta" && cwd === undefined) {
        const payload = rec["payload"] as Record<string, unknown> | undefined
        if (typeof payload?.["cwd"] === "string") cwd = payload["cwd"]
      }
      if (title === undefined && rec["type"] === "response_item") {
        const payload = rec["payload"] as Record<string, unknown> | undefined
        if (!payload || payload["type"] !== "message" || payload["role"] !== "user") {
          continue
        }
        const content = payload["content"]
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>)["type"] === "input_text" &&
            typeof (block as Record<string, unknown>)["text"] === "string"
          ) {
            const t = String((block as Record<string, unknown>)["text"]).trim()
            if (t && !isGeneratedMetaText(t)) {
              title = t.replace(/\s+/g, " ").slice(0, 120)
              break
            }
          }
        }
      }
      if (cwd !== undefined && title !== undefined) break
    }
    return { cwd, title }
  })

export const listCodexSessions = Effect.fn("codex.list")(function* (opts: {
  cwd?: string | undefined
  withinMin?: number | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const home = yield* resolveCodexHome()
  const exists = yield* fs.exists(home)
  if (!exists) return [] as ReadonlyArray<SessionRef>

  // Rollouts live under sessions/ (dated subdirs), plus archived/backup
  // roots. A populated workspaces/ tree can hold 1M+ files and must never
  // be walked, so only known roots are recursed (plus depth-1 top-level
  // files for legacy layouts). Full-home walk is the last resort.
  const roots: Array<string> = []
  for (const name of ["sessions", "archived_sessions", "backup-sessions"]) {
    const dir = pathApi.join(home, name)
    if (yield* fs.exists(dir)) roots.push(dir)
  }
  const nested = yield* Effect.forEach(
    roots,
    (dir) => walkRollouts(dir, 0),
    { concurrency: 8 },
  )
  const paths: Array<string> = nested.flat()
  const topNames = yield* fs
    .readDirectory(home)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>))
  for (const name of topNames) {
    if (!CODEX_ROLLOUT_RE.test(name)) continue
    const full = pathApi.join(home, name)
    const stat = yield* fs.stat(full).pipe(Effect.orElseSucceed(() => undefined))
    if (stat?.type === "File" && !paths.includes(full)) paths.push(full)
  }
  if (paths.length === 0 && roots.length === 0) {
    paths.push(...(yield* walkRollouts(home, 0)))
  }
  const now = yield* Clock.currentTimeMillis

  // Pass 1: cheap metadata (stat only). Avoid opening every rollout for title.
  const bare = yield* Effect.forEach(
    paths,
    (path) =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(path).pipe(Effect.orElseSucceed(() => undefined))
        if (!stat) return Option.none<{ path: string; sessionId: string; updatedAtMs: number }>()
        const mtime = Option.getOrUndefined(stat.mtime)
        const updatedAtMs = mtime ? mtime.getTime() : 0
        if (!withinWindow(updatedAtMs, opts.withinMin, now)) {
          return Option.none()
        }
        if (opts.cwd) {
          // One 20-line probe per file; session_meta is normally the first record.
          const header = yield* headerProbe(path, 20)
          if (header.cwd !== undefined && header.cwd !== opts.cwd) return Option.none()
        }
        const base = pathApi.basename(path)
        const match = CODEX_ROLLOUT_RE.exec(base)
        const sessionId = match?.[1] ?? base
        return Option.some({ path, sessionId, updatedAtMs })
      }),
    { concurrency: 32 },
  )

  const sorted = bare
    .flatMap((r) => (Option.isSome(r) ? [r.value] : []))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)

  // Pass 2: title only for the most recent sessions (list UX), not all 10k+.
  // Compressed rollouts are stat-only here: decompressing every .zst for a
  // title would cost a zstd subprocess per file.
  const titleTargets = new Set(
    sorted
      .slice(0, TITLE_PEEK_LIMIT)
      .map((r) => r.path)
      .filter((p) => !p.endsWith(".zst")),
  )
  const titles = yield* Effect.forEach(
    [...titleTargets],
    (path) =>
      Effect.gen(function* () {
        const header = yield* headerProbe(path, 80)
        return [path, header.title] as const
      }),
    { concurrency: 16 },
  )
  const titleByPath = new Map(titles)

  return sorted.map(
    (item) =>
      new SessionRef({
        format: "codex",
        sessionId: item.sessionId,
        path: item.path,
        ...(titleByPath.get(item.path)
          ? { title: titleByPath.get(item.path) }
          : {}),
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        updatedAt: new Date(item.updatedAtMs).toISOString(),
        updatedAtMs: item.updatedAtMs,
      }),
  )
})
