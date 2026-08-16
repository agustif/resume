import { Effect } from "effect"
import type { FormatId } from "../ir/index.js"
import type { DecodeOpts, ListOpts } from "./adapter.js"
import { UnsupportedCapability } from "./errors.js"
import {
  encodeHandoffPackJson,
  renderHandoffMarkdown,
  toHandoffPack,
} from "./handoff.js"
import { AdapterRegistry } from "./registry.js"
import { sanitizeSession } from "./safety.js"

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

export const listCapabilities = Effect.fn("resume.listCapabilities")(function* () {
  const registry = yield* AdapterRegistry
  const adapters = yield* registry.all()
  return adapters.map((a) => a.capabilities)
})
