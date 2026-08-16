import { Schema } from "effect"
import { FormatId, SessionRef } from "../ir/index.js"

export class UnknownFormat extends Schema.TaggedError<UnknownFormat>()("UnknownFormat", {
  format: Schema.String,
}) {}

export class AmbiguousRef extends Schema.TaggedError<AmbiguousRef>()("AmbiguousRef", {
  reference: Schema.String,
  matches: Schema.Array(SessionRef),
}) {}

export class SessionNotFound extends Schema.TaggedError<SessionNotFound>()("SessionNotFound", {
  format: FormatId,
  reference: Schema.String,
}) {}

export class DecodeFailed extends Schema.TaggedError<DecodeFailed>()("DecodeFailed", {
  format: FormatId,
  path: Schema.String,
  reason: Schema.String,
}) {}

export class UnsupportedCapability extends Schema.TaggedError<UnsupportedCapability>()(
  "UnsupportedCapability",
  {
    format: FormatId,
    capability: Schema.Literals(["list", "decode", "handoff", "transplant"]),
  },
) {}

export type ResumeError =
  | UnknownFormat
  | AmbiguousRef
  | SessionNotFound
  | DecodeFailed
  | UnsupportedCapability
