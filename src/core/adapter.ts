import type { Effect } from "effect"
import type { ConfigError } from "effect/Config"
import type { FileSystem } from "effect/FileSystem"
import type { Path } from "effect/Path"
import type { PlatformError } from "effect/PlatformError"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Capabilities, FormatId, Session, SessionRef } from "../ir/index.js"
import type {
  AmbiguousRef,
  DecodeFailed,
  SessionNotFound,
  UnsupportedCapability,
  UnknownFormat,
} from "./errors.js"

export interface ListOpts {
  readonly cwd?: string | undefined
  readonly withinMin?: number | undefined
}

export interface DecodeOpts {
  readonly cwd?: string | undefined
  readonly maxToolChars?: number | undefined
}

export type ListError =
  | UnsupportedCapability
  | PlatformError
  | ConfigError
  | DecodeFailed

export type DecodeError =
  | SessionNotFound
  | AmbiguousRef
  | DecodeFailed
  | UnsupportedCapability
  | PlatformError
  | ConfigError

/** Services adapters may require. */
export type AdapterServices = FileSystem | Path | ChildProcessSpawner

/**
 * Per-format session adapter.
 * Decode is an Effect pipeline (multi-pass), not a pure Schema whole-file transform.
 */
export interface SessionAdapter {
  readonly id: FormatId
  readonly capabilities: Capabilities
  readonly list: (
    opts: ListOpts,
  ) => Effect.Effect<ReadonlyArray<SessionRef>, ListError, AdapterServices>
  readonly decode: (
    ref: string,
    opts: DecodeOpts,
  ) => Effect.Effect<Session, DecodeError, AdapterServices>
}

export type RegistryError = UnknownFormat
