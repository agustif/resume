import { Schema } from "effect"
import { FormatId } from "./formats.js"

/** Shared IR version stamp. Bump when the IR schema shape changes. */
export const IR_VERSION = "0.1.0" as const

export const SessionId = Schema.String.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

export const CanonicalTool = Schema.Literals([
  "shell",
  "read",
  "edit",
  "search",
  "mcp",
  "unknown",
])
export type CanonicalTool = typeof CanonicalTool.Type

export class ToolCall extends Schema.Class<ToolCall>("ToolCall")({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  canonical: Schema.optionalKey(CanonicalTool),
  argsPreview: Schema.String,
  inert: Schema.Literal(true),
}) {}

export class ToolResult extends Schema.Class<ToolResult>("ToolResult")({
  callId: Schema.optionalKey(Schema.String),
  content: Schema.String,
  isError: Schema.Boolean,
  unavailable: Schema.Boolean,
  inert: Schema.Literal(true),
}) {}

export class UserTurn extends Schema.TaggedClass<UserTurn>()("User", {
  text: Schema.String,
  toolResults: Schema.optionalKey(Schema.Array(ToolResult)),
}) {}

export class AssistantTurn extends Schema.TaggedClass<AssistantTurn>()("Assistant", {
  text: Schema.optionalKey(Schema.String),
  toolCalls: Schema.Array(ToolCall),
}) {}

export class ToolResultTurn extends Schema.TaggedClass<ToolResultTurn>()("ToolResult", {
  results: Schema.Array(ToolResult),
}) {}

export class BoundaryTurn extends Schema.TaggedClass<BoundaryTurn>()("Boundary", {
  kind: Schema.Literals(["compact", "rollback", "snip", "away", "status"]),
  note: Schema.optionalKey(Schema.String),
}) {}

export const Turn = Schema.Union([
  UserTurn,
  AssistantTurn,
  ToolResultTurn,
  BoundaryTurn,
])
export type Turn = typeof Turn.Type

export class Warning extends Schema.Class<Warning>("Warning")({
  code: Schema.String,
  message: Schema.String,
}) {}

export class SessionSource extends Schema.Class<SessionSource>("SessionSource")({
  format: FormatId,
  path: Schema.String,
  formatVersion: Schema.optionalKey(Schema.String),
}) {}

export class SessionMeta extends Schema.Class<SessionMeta>("SessionMeta")({
  title: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
}) {}

/** One Claude sidechain transcript (`<session>/subagents/agent-*.jsonl`). */
export class SubagentRun extends Schema.Class<SubagentRun>("SubagentRun")({
  id: Schema.String,
  path: Schema.String,
  agentType: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  toolUseId: Schema.optionalKey(Schema.String),
  parentAgentId: Schema.optionalKey(Schema.String),
  spawnDepth: Schema.optionalKey(Schema.Number),
  isFork: Schema.optionalKey(Schema.Boolean),
  updatedAt: Schema.optionalKey(Schema.String),
  turns: Schema.Array(Turn),
  warnings: Schema.Array(Warning),
}) {}

export class Session extends Schema.Class<Session>("Session")({
  irVersion: Schema.Literal(IR_VERSION),
  id: SessionId,
  source: SessionSource,
  meta: SessionMeta,
  turns: Schema.Array(Turn),
  warnings: Schema.Array(Warning),
  subagents: Schema.optionalKey(Schema.Array(SubagentRun)),
}) {}

export class SessionRef extends Schema.Class<SessionRef>("SessionRef")({
  format: FormatId,
  sessionId: Schema.String,
  path: Schema.String,
  title: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  updatedAt: Schema.optionalKey(Schema.String),
  updatedAtMs: Schema.Number,
}) {}

export const CapabilityFidelity = Schema.Struct({
  list: Schema.Literals(["L0", "none"]),
  decode: Schema.Literals(["L1", "none"]),
  handoff: Schema.Literals(["L2", "none"]),
  transplant: Schema.Literals(["L3", "L4", "none"]),
})

export class Capabilities extends Schema.Class<Capabilities>("Capabilities")({
  format: FormatId,
  list: Schema.Boolean,
  decode: Schema.Boolean,
  handoff: Schema.Boolean,
  transplant: Schema.Boolean,
  fidelity: CapabilityFidelity,
}) {}
