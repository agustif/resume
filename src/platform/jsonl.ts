import {
  Effect,
  FileSystem,
  Option,
  Result,
  Stream,
} from "effect"
import { Ndjson } from "effect/unstable/encoding"
import { DecodeFailed } from "../core/errors.js"
import type { FormatId } from "../ir/formats.js"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export interface JsonlReadResult {
  readonly records: ReadonlyArray<Record<string, unknown>>
  readonly malformed: number
}

/**
 * Read a plain JSONL file using FileSystem streams + Effect Stream.
 * Malformed lines are counted and skipped (session transcripts are often dirty).
 */
export const readJsonlRecords = Effect.fn("platform.readJsonlRecords")(
  function* (path: string, format: FormatId) {
    const fs = yield* FileSystem.FileSystem

    const results = yield* fs.stream(path).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.mapEffect((line) =>
        Effect.result(
          Effect.try({
            try: () => JSON.parse(line) as unknown,
            catch: (cause) => cause,
          }),
        ),
      ),
      Stream.runCollect,
      Effect.mapError(
        (cause) =>
          new DecodeFailed({
            format,
            path,
            reason: `failed to stream jsonl: ${String(cause)}`,
          }),
      ),
    )

    let malformed = 0
    const records: Array<Record<string, unknown>> = []
    for (const result of results) {
      if (Result.isFailure(result)) {
        malformed += 1
        continue
      }
      if (isRecord(result.success)) {
        records.push(result.success)
      } else {
        malformed += 1
      }
    }

    return { records, malformed } satisfies JsonlReadResult
  },
)

/**
 * Parse NDJSON text (e.g. after zstd decompress) via unstable Ndjson channel.
 * Falls back to per-line recovery when the channel fails mid-stream.
 */
export const parseNdjsonText = Effect.fn("platform.parseNdjsonText")(
  function* (text: string, format: FormatId, path: string) {
    const decoded = yield* Effect.result(
      Stream.make(text).pipe(
        Stream.pipeThroughChannel(Ndjson.decodeString({ ignoreEmptyLines: true })),
        Stream.runCollect,
      ),
    )

    if (Result.isSuccess(decoded)) {
      let malformed = 0
      const records: Array<Record<string, unknown>> = []
      for (const value of decoded.success) {
        if (isRecord(value)) records.push(value)
        else malformed += 1
      }
      return { records, malformed } satisfies JsonlReadResult
    }

    yield* Effect.logDebug("ndjson channel failed; recovering line-by-line", {
      path,
      error: String(decoded.failure),
    })

    let malformed = 0
    const records: Array<Record<string, unknown>> = []
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      const parsed = yield* Effect.result(
        Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: (cause) => cause,
        }),
      )
      if (Result.isFailure(parsed)) {
        malformed += 1
        continue
      }
      if (isRecord(parsed.success)) records.push(parsed.success)
      else malformed += 1
    }

    if (records.length === 0 && malformed > 0) {
      return yield* new DecodeFailed({
        format,
        path,
        reason: "no valid jsonl records after recovery",
      })
    }

    return { records, malformed } satisfies JsonlReadResult
  },
)

export const optionalString = (value: unknown): Option.Option<string> =>
  typeof value === "string" && value.length > 0 ? Option.some(value) : Option.none()
