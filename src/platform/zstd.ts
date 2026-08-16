import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { DecodeFailed } from "../core/errors.js"
import type { FormatId } from "../ir/formats.js"

/**
 * Decompress a `.jsonl.zst` session file via `zstd -dc` using Effect's
 * unstable process module (ChildProcess + ChildProcessSpawner).
 */
export const decompressZstdFile = Effect.fn("platform.decompressZstdFile")(
  function* (path: string, format: FormatId) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner
      .string(ChildProcess.make("zstd", ["-dc", path]))
      .pipe(
        Effect.mapError(
          (cause) =>
            new DecodeFailed({
              format,
              path,
              reason: `zstd decompress failed (is zstd on PATH?): ${String(cause)}`,
            }),
        ),
      )
  },
)
