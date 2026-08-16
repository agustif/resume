import { Context, Effect, Layer, Schema } from "effect"
import { FormatId } from "../ir/index.js"
import type { SessionAdapter } from "./adapter.js"
import { UnknownFormat } from "./errors.js"

export class AdapterRegistry extends Context.Service<
  AdapterRegistry,
  {
    readonly get: (id: string) => Effect.Effect<SessionAdapter, UnknownFormat>
    readonly all: () => Effect.Effect<ReadonlyArray<SessionAdapter>>
  }
>()("resume/AdapterRegistry") {}

export const makeAdapterRegistry = (
  adapters: ReadonlyArray<SessionAdapter>,
): AdapterRegistry["Service"] => {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter] as const))

  return {
    get: Effect.fn("AdapterRegistry.get")(function* (id: string) {
      const format = yield* Schema.decodeUnknownEffect(FormatId)(id).pipe(
        Effect.mapError(() => new UnknownFormat({ format: id })),
      )
      const adapter = byId.get(format)
      if (adapter === undefined) {
        return yield* new UnknownFormat({ format: id })
      }
      return adapter
    }),
    all: () => Effect.succeed(adapters),
  }
}

export const layerAdapterRegistry = (
  adapters: ReadonlyArray<SessionAdapter>,
): Layer.Layer<AdapterRegistry> =>
  Layer.succeed(AdapterRegistry)(makeAdapterRegistry(adapters))
