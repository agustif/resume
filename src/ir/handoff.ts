import { Schema } from "effect"
import { FormatId } from "./formats.js"

export class HandoffWarning extends Schema.Class<HandoffWarning>("HandoffWarning")({
  code: Schema.String,
  message: Schema.String,
}) {}

/**
 * Safe, lossy handoff pack for another agent/human.
 * Semantic model distinct from full Session IR (guide: real difference → own schema).
 */
export class HandoffPack extends Schema.Class<HandoffPack>("HandoffPack")({
  format: FormatId,
  sessionId: Schema.String,
  path: Schema.String,
  title: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  lastUserRequest: Schema.optionalKey(Schema.String),
  lastAssistantAction: Schema.optionalKey(Schema.String),
  turnCount: Schema.Number,
  recentTurns: Schema.Array(Schema.String),
  warnings: Schema.Array(HandoffWarning),
  safetyNote: Schema.String,
}) {}

/** Canonical JSON codec for handoff packs (Schema.toCodecJson). */
export const HandoffPackJson = Schema.toCodecJson(HandoffPack)

export const encodeHandoffJson = Schema.encodeEffect(HandoffPackJson)
export const decodeHandoffJson = Schema.decodeUnknownEffect(HandoffPackJson)
