import { Effect, FileSystem, Path } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { decodeClaudeFile } from "../adapters/claude/decode.js"
import { listClaudeSessions } from "../adapters/claude/list.js"
import { listClaudeSubagentMetas, loadClaudeSubagent } from "../adapters/claude/subagents.js"
import { IR_VERSION, type FormatId, type Turn, type Warning } from "../ir/index.js"
import { resolveSessionRef } from "../platform/resolve.js"
import type { DecodeOpts, ListOpts } from "./adapter.js"
import { DecodeFailed, UnsupportedCapability } from "./errors.js"
import {
  encodeHandoffPackJson,
  renderHandoffMarkdown,
  toHandoffPack,
} from "./handoff.js"
import { AdapterRegistry } from "./registry.js"
import { sanitizeSession, sanitizeTurnList } from "./safety.js"

export interface ExploreSource {
  scope: string
  path: string
  title?: string | undefined
  turns: ReadonlyArray<Turn>
  warnings: ReadonlyArray<Warning>
  agentMatches?: ReadonlyArray<string> | undefined
}

export const listSessions = Effect.fn("resume.listSessions")(function* (
  format: FormatId | "all",
  opts: ListOpts,
) {
  const registry = yield* AdapterRegistry
  const adapters =
    format === "all" ? yield* registry.all() : [yield* registry.get(format)]

  const groups = yield* Effect.forEach(
    adapters,
    (adapter) =>
      adapter.capabilities.list
        ? adapter.list(opts)
        : Effect.succeed([] as const),
    { concurrency: "unbounded" },
  )

  return groups.flat().sort((a, b) => b.updatedAtMs - a.updatedAtMs)
})

export const showSession = Effect.fn("resume.showSession")(function* (
  format: FormatId,
  ref: string,
  opts: DecodeOpts,
) {
  const registry = yield* AdapterRegistry
  const adapter = yield* registry.get(format)
  if (!adapter.capabilities.decode) {
    return yield* new UnsupportedCapability({ format, capability: "decode" })
  }
  const session = yield* adapter.decode(ref, opts)
  return sanitizeSession(session)
})

export const handoffSession = Effect.fn("resume.handoffSession")(function* (
  format: FormatId,
  ref: string,
  opts: DecodeOpts,
) {
  const registry = yield* AdapterRegistry
  const adapter = yield* registry.get(format)
  if (!adapter.capabilities.handoff && !adapter.capabilities.decode) {
    return yield* new UnsupportedCapability({ format, capability: "handoff" })
  }
  const session = sanitizeSession(yield* adapter.decode(ref, opts))
  const pack = toHandoffPack(session)
  const json = yield* encodeHandoffPackJson(pack)
  return {
    session,
    pack,
    markdown: renderHandoffMarkdown(pack),
    json,
  }
})

export interface TransplantOpts {
  readonly cwd?: string | undefined
  readonly maxToolChars?: number | undefined
  readonly outDir: string
}

export interface TransplantManifest {
  readonly irVersion: string
  readonly format: FormatId
  readonly sessionId: string
  readonly exportedAt: string
  readonly files: ReadonlyArray<string>
}

export interface TransplantResult {
  readonly outDir: string
  readonly manifest: TransplantManifest
  /** Every file written, in write order (payload files, then the manifest). */
  readonly written: ReadonlyArray<string>
}

const TRANSPLANT_PAYLOAD_FILES = ["session.json", "handoff.md", "handoff.json"] as const

/**
 * Portable transplant bundle (L3): sanitized IR + handoff renderers + manifest
 * written into `outDir` (created recursively). Native per-tool session files a
 * foreign host could re-execute are deliberately out of scope.
 */
export const transplantSession = Effect.fn("resume.transplantSession")(function* (
  format: FormatId,
  ref: string,
  opts: TransplantOpts,
) {
  const registry = yield* AdapterRegistry
  const adapter = yield* registry.get(format)
  if (!adapter.capabilities.transplant && !adapter.capabilities.decode) {
    return yield* new UnsupportedCapability({ format, capability: "transplant" })
  }
  const session = sanitizeSession(
    yield* adapter.decode(ref, { cwd: opts.cwd, maxToolChars: opts.maxToolChars }),
  )
  const pack = toHandoffPack(session)
  const json = yield* encodeHandoffPackJson(pack)
  const markdown = renderHandoffMarkdown(pack)

  const fs = yield* FileSystem.FileSystem
  const pathApi = yield* Path.Path
  const outDir = opts.outDir
  const fail = (path: string, reason: string) =>
    new DecodeFailed({ format, path, reason: `transplant outDir unusable: ${reason}` })

  yield* fs.makeDirectory(outDir, { recursive: true }).pipe(
    Effect.mapError((error: PlatformError) => fail(outDir, error.reason.message)),
  )

  const payloads: ReadonlyArray<readonly [string, string]> = [
    ["session.json", JSON.stringify(session, null, 2)],
    ["handoff.md", markdown],
    ["handoff.json", json],
  ]
  for (const [name, content] of payloads) {
    const target = pathApi.join(outDir, name)
    yield* fs.writeFileString(target, content).pipe(
      Effect.mapError((error: PlatformError) => fail(target, error.reason.message)),
    )
  }

  const manifest: TransplantManifest = {
    irVersion: IR_VERSION,
    format: session.source.format,
    sessionId: session.id,
    exportedAt: new Date().toISOString(),
    files: [...TRANSPLANT_PAYLOAD_FILES],
  }
  const manifestPath = pathApi.join(outDir, "manifest.json")
  yield* fs.writeFileString(manifestPath, JSON.stringify(manifest, null, 2)).pipe(
    Effect.mapError((error: PlatformError) => fail(manifestPath, error.reason.message)),
  )

  return { outDir, manifest, written: [...TRANSPLANT_PAYLOAD_FILES, "manifest.json"] }
})

const sourceFromSession = (session: {
  source: { path: string }
  meta: { title?: string | undefined }
  turns: ReadonlyArray<Turn>
  warnings: ReadonlyArray<Warning>
}): ExploreSource => ({
  scope: "session",
  path: session.source.path,
  ...(session.meta.title !== undefined ? { title: session.meta.title } : {}),
  turns: session.turns,
  warnings: session.warnings,
})

/**
 * Parent transcript only, unless `agentId` is set. Claude subagents stay
 * unloaded until one id is opened.
 */
export const openForExplore = Effect.fn("resume.openForExplore")(function* (
  format: FormatId,
  ref: string,
  opts: {
    readonly cwd?: string | undefined
    readonly agentId?: string | undefined
    readonly maxToolChars?: number | undefined
  },
) {
  if (format === "claude") {
    const sessions = yield* listClaudeSessions({ cwd: opts.cwd })
    const path = yield* resolveSessionRef("claude", ref, sessions)
    if (opts.agentId) {
      const picked = yield* loadClaudeSubagent(path, opts.agentId, opts.maxToolChars ?? 0)
      if (picked._tag === "None") {
        return {
          scope: "missing-agent",
          path,
          turns: [],
          warnings: [],
          agentMatches: [],
        } satisfies ExploreSource
      }
      if (picked._tag === "Many") {
        return {
          scope: "ambiguous-agent",
          path,
          turns: [],
          warnings: [],
          agentMatches: picked.ids,
        } satisfies ExploreSource
      }
      return {
        scope: `agent ${picked.run.id}`,
        path: picked.run.path,
        ...(picked.run.description !== undefined ? { title: picked.run.description } : {}),
        turns: sanitizeTurnList(picked.run.turns).turns,
        warnings: picked.run.warnings,
      } satisfies ExploreSource
    }
    return sourceFromSession(
      sanitizeSession(yield* decodeClaudeFile(path, opts.maxToolChars ?? 0)),
    )
  }

  const session = yield* showSession(format, ref, {
    cwd: opts.cwd,
    maxToolChars: opts.maxToolChars,
  })
  if (!opts.agentId) return sourceFromSession(session)
  const needle = opts.agentId
  const matches = (session.subagents ?? []).filter(
    (agent) => agent.id === needle || agent.id.startsWith(needle),
  )
  const only = matches.length === 1 ? matches[0] : undefined
  if (!only) {
    return {
      scope: matches.length === 0 ? "missing-agent" : "ambiguous-agent",
      path: session.source.path,
      turns: [],
      warnings: session.warnings,
      agentMatches: matches.map((agent) => agent.id),
    } satisfies ExploreSource
  }
  return {
    scope: `agent ${only.id}`,
    path: only.path,
    ...(only.description !== undefined ? { title: only.description } : {}),
    turns: sanitizeTurnList(only.turns).turns,
    warnings: only.warnings,
  } satisfies ExploreSource
})

export const listExploreAgents = Effect.fn("resume.listExploreAgents")(function* (
  format: FormatId,
  ref: string,
  opts: { readonly cwd?: string | undefined },
) {
  if (format === "claude") {
    const sessions = yield* listClaudeSessions({ cwd: opts.cwd })
    const path = yield* resolveSessionRef("claude", ref, sessions)
    const metas = yield* listClaudeSubagentMetas(path)
    return metas.map((meta) => ({
      id: meta.id,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      ...(meta.agentType !== undefined ? { agentType: meta.agentType } : {}),
      ...(meta.spawnDepth !== undefined ? { spawnDepth: meta.spawnDepth } : {}),
      ...(meta.isFork !== undefined ? { isFork: meta.isFork } : {}),
    }))
  }
  const session = yield* showSession(format, ref, { cwd: opts.cwd })
  return (session.subagents ?? []).map((agent) => ({
    id: agent.id,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(agent.agentType !== undefined ? { agentType: agent.agentType } : {}),
    ...(agent.spawnDepth !== undefined ? { spawnDepth: agent.spawnDepth } : {}),
    ...(agent.isFork !== undefined ? { isFork: agent.isFork } : {}),
    turns: agent.turns.length,
  }))
})

export const listCapabilities = Effect.fn("resume.listCapabilities")(function* () {
  const registry = yield* AdapterRegistry
  const adapters = yield* registry.all()
  return adapters.map((a) => a.capabilities)
})
