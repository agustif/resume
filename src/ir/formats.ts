import { Schema } from "effect"

/** Supported agent session formats. */
export const FormatId = Schema.Literals([
  "claude",
  "codex",
  "grok",
  "cursor",
  "opencode",
  "pi",
])
export type FormatId = typeof FormatId.Type

export const FORMAT_IDS = FormatId.literals

/** Progressive fidelity for the conversion matrix. */
export const FidelityLevel = Schema.Literals([
  "L0", // discover/list only
  "L1", // decode → IR
  "L2", // encode handoff pack
  "L3", // encode native files (best-effort)
  "L4", // target can natively resume with confidence
])
export type FidelityLevel = typeof FidelityLevel.Type
