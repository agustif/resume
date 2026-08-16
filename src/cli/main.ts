#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, Match, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  handoffSession,
  listCapabilities,
  listSessions,
  showSession,
} from "../core/orchestrator.js"
import { FORMAT_IDS, type FormatId } from "../ir/formats.js"
import { AppLayer } from "../layers.js"

const LIST_FORMATS = ["all", ...FORMAT_IDS] as const

const formatArg = Argument.choice("format", FORMAT_IDS).pipe(
  Argument.withDescription("Session format (claude, codex, grok, ...)"),
)

const refArg = Argument.string("ref").pipe(
  Argument.withDescription("Session id, path, free-text query, or 'latest'"),
  Argument.withDefault("latest"),
)

const cwdFlag = Flag.directory("cwd").pipe(
  Flag.withDescription("Filter / resolve relative to this working directory"),
  Flag.optional,
)

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Machine-readable JSON output"),
  Flag.withAlias("j"),
  Flag.withDefault(false),
)

const withinFlag = Flag.integer("within-min").pipe(
  Flag.withDescription("Only sessions updated within N minutes"),
  Flag.optional,
)

const verboseFlag = Flag.boolean("verbose").pipe(
  Flag.withAlias("v"),
  Flag.withDescription("Print diagnostic logs"),
  Flag.withDefault(false),
)

const resume = Command.make("resume").pipe(
  Command.withDescription(
    "Universal coding-agent session interchange (list / show / handoff)",
  ),
  Command.withSharedFlags({
    json: jsonFlag,
    cwd: cwdFlag,
    verbose: verboseFlag,
  }),
)

const capabilities = Command.make(
  "capabilities",
  {},
  Effect.fn("cli.capabilities")(function* () {
    const caps = yield* listCapabilities()
    const rows = caps.map((c) => ({
      format: c.format,
      list: c.list ? c.fidelity.list : "none",
      decode: c.decode ? c.fidelity.decode : "none",
      handoff: c.handoff ? c.fidelity.handoff : "none",
      transplant: c.transplant ? c.fidelity.transplant : "none",
    }))
    yield* Console.log(
      [
        "format     list  decode  handoff  transplant",
        "---------- ----- ------- -------- ----------",
        ...rows.map(
          (r) =>
            `${r.format.padEnd(10)} ${r.list.padEnd(5)} ${r.decode.padEnd(7)} ${r.handoff.padEnd(8)} ${r.transplant}`,
        ),
      ].join("\n"),
    )
  }),
).pipe(Command.withDescription("Show fidelity matrix for each format adapter"))

const list = Command.make(
  "list",
  {
    format: Flag.choice("format", LIST_FORMATS).pipe(
      Flag.withDescription("Format to list (default: all)"),
      Flag.withDefault("all" as const),
    ),
    withinMin: withinFlag,
  },
  Effect.fn("cli.list")(function* ({ format, withinMin }) {
    const root = yield* resume
    const refs = yield* listSessions(format, {
      cwd: Option.getOrUndefined(root.cwd),
      withinMin: Option.getOrUndefined(withinMin),
    })

    if (root.verbose) {
      yield* Console.log(`found ${refs.length} session(s) format=${format}`)
    }

    if (root.json) {
      yield* Console.log(JSON.stringify(refs, null, 2))
      return
    }
    if (refs.length === 0) {
      yield* Console.log("No sessions found.")
      return
    }
    for (const ref of refs.slice(0, 50)) {
      const title = ref.title ?? "(untitled)"
      const when = ref.updatedAt ?? String(ref.updatedAtMs)
      yield* Console.log(
        `${ref.format.padEnd(8)} ${ref.sessionId.slice(0, 36).padEnd(36)}  ${when}  ${title}`,
      )
    }
    if (refs.length > 50) {
      yield* Console.log(`... and ${refs.length - 50} more`)
    }
  }),
).pipe(Command.withDescription("List local sessions"), Command.withAlias("ls"))

const show = Command.make(
  "show",
  {
    format: formatArg,
    ref: refArg,
  },
  Effect.fn("cli.show")(function* ({ format, ref }) {
    const root = yield* resume
    const session = yield* showSession(format, ref, {
      cwd: Option.getOrUndefined(root.cwd),
    })

    if (root.json) {
      yield* Console.log(JSON.stringify(session, null, 2))
      return
    }

    yield* Console.log(`format:  ${session.source.format}`)
    yield* Console.log(`id:      ${session.id}`)
    yield* Console.log(`path:    ${session.source.path}`)
    if (session.meta.title) yield* Console.log(`title:   ${session.meta.title}`)
    if (session.meta.cwd) yield* Console.log(`cwd:     ${session.meta.cwd}`)
    if (session.meta.branch) yield* Console.log(`branch:  ${session.meta.branch}`)
    yield* Console.log(`turns:   ${session.turns.length}`)
    yield* Console.log(`warnings:${session.warnings.length}`)
    for (const w of session.warnings) {
      yield* Console.log(`  - [${w.code}] ${w.message}`)
    }
    yield* Console.log("")
    yield* Console.log("recent turns:")
    for (const turn of session.turns.slice(-8)) {
      const line = Match.valueTags(turn, {
        User: (t) => `  user: ${t.text.replace(/\s+/g, " ").slice(0, 160)}`,
        Assistant: (t) => {
          const text = t.text?.replace(/\s+/g, " ").slice(0, 160) ?? ""
          const tools = t.toolCalls.map((c) => c.name).join(", ")
          return `  assistant: ${text}${tools ? ` [tools: ${tools}]` : ""}`
        },
        ToolResult: (t) => `  tool-result: ${t.results.length}`,
        Boundary: (t) => `  boundary: ${t.kind}`,
      })
      yield* Console.log(line)
    }
  }),
).pipe(Command.withDescription("Decode a session into the shared IR and print a summary"))

const handoff = Command.make(
  "handoff",
  {
    format: formatArg,
    ref: refArg,
  },
  Effect.fn("cli.handoff")(function* ({ format, ref }) {
    const root = yield* resume
    const result = yield* handoffSession(format, ref, {
      cwd: Option.getOrUndefined(root.cwd),
    })
    if (root.json) {
      // pre-encoded via Schema.toCodecJson
      yield* Console.log(result.json)
      return
    }
    yield* Console.log(result.markdown)
  }),
).pipe(
  Command.withDescription(
    "Produce a safe handoff pack (markdown or JSON) from a foreign session",
  ),
)

resume.pipe(
  Command.withSubcommands([capabilities, list, show, handoff]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(AppLayer),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
)

// FormatId re-export keeps inference happy for tooling
export type { FormatId }
