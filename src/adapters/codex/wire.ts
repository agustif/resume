import { Schema } from "effect"

/**
 * Partial wire schemas for Codex rollout records.
 * Full reconstruction still uses an Effect pipeline (compaction, rollbacks).
 */

export class CodexEnvelope extends Schema.Class<CodexEnvelope>("CodexEnvelope")({
  type: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  payload: Schema.optionalKey(Schema.Unknown),
}) {}

export class CodexSessionMetaPayload extends Schema.Class<CodexSessionMetaPayload>(
  "CodexSessionMetaPayload",
)({
  id: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  cli_version: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  git_branch: Schema.optionalKey(Schema.String),
  git: Schema.optionalKey(
    Schema.Struct({
      branch: Schema.optionalKey(Schema.String),
    }),
  ),
}) {}

export const decodeEnvelope = Schema.decodeUnknownOption(CodexEnvelope)
export const decodeSessionMeta = Schema.decodeUnknownOption(CodexSessionMetaPayload)
