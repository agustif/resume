import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import {
  PAGE_LIMIT_DEFAULT,
  PAGE_LIMIT_MAX,
  READ_CHARS_DEFAULT,
  READ_CHARS_MAX,
  boundaryIndexes,
  findTurns,
  formatAgentLine,
  pageFooter,
  pageLine,
  sliceText,
  turnBody,
  turnKind,
  userRequestIndexes,
  windowOf,
} from "../core/explore.js"
import { listExploreAgents, openForExplore, type ExploreSource } from "../core/orchestrator.js"
import { FORMAT_IDS, type FormatId } from "../ir/formats.js"

type RootFlags = {
  json: boolean
  cwd: Option.Option<string>
  verbose: boolean
  maxToolChars: Option.Option<number>
}

const formatArg = Argument.choice("format", FORMAT_IDS).pipe(
  Argument.withDescription("Session format (claude, codex, grok, ...)"),
)

const refArg = Argument.string("ref").pipe(
  Argument.withDescription("Session id, path, free-text query, or 'latest'"),
  Argument.withDefault("latest"),
)

const fromFlag = Flag.integer("from").pipe(
  Flag.withDescription("Zero-based start index or character offset"),
  Flag.withDefault(0),
)

const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription(`How many entries to print, max ${PAGE_LIMIT_MAX}`),
  Flag.withDefault(PAGE_LIMIT_DEFAULT),
)

const agentFlag = Flag.string("agent").pipe(
  Flag.withDescription("Subagent id or a unique prefix. Loads that transcript only."),
  Flag.optional,
)

const ndjsonFlag = Flag.boolean("ndjson").pipe(
  Flag.withDescription("Print one JSON object per line, then a page trailer"),
  Flag.withDefault(false),
)

const charsFlag = Flag.integer("chars").pipe(
  Flag.withDescription(`Characters to print from this turn, max ${READ_CHARS_MAX}`),
  Flag.withDefault(READ_CHARS_DEFAULT),
)

const turnFlag = Flag.integer("turn").pipe(
  Flag.withDescription("Turn index from outline, page, or find"),
)

const queryFlag = Flag.string("query").pipe(
  Flag.withAlias("q"),
  Flag.withDescription("Case-insensitive substring across the turn text and tool output"),
)

const agentBit = (agent: string | undefined): string =>
  agent ? ` --agent ${JSON.stringify(agent)}` : ""

const cwdBit = (cwd: string | undefined): string =>
  cwd ? ` --cwd ${JSON.stringify(cwd)}` : ""

const resumeCmd = (
  name: string,
  format: string,
  ref: string,
  opts: { cwd?: string | undefined; agentId?: string | undefined },
): string =>
  `resume${cwdBit(opts.cwd)} ${name} ${format} ${JSON.stringify(ref)}${agentBit(opts.agentId)}`

const refuseScope = (source: ExploreSource): string | undefined => {
  if (source.scope === "missing-agent") return "no subagent matches that id"
  if (source.scope === "ambiguous-agent") {
    const ids = source.agentMatches ?? []
    return [`agent id is ambiguous:`, ...ids].join("\n")
  }
  return undefined
}

const printBounded = (opts: {
  json: boolean
  ndjson: boolean
  payload: {
    scope: string
    path: string
    title?: string | undefined
    total: number
    from: number
    limit: number
    nextFrom: number | null
    items: ReadonlyArray<unknown>
  }
  text: string
}) =>
  Effect.gen(function* () {
    if (opts.ndjson) {
      for (const item of opts.payload.items) {
        yield* Console.log(JSON.stringify(item))
      }
      yield* Console.log(
        JSON.stringify({
          type: "page",
          scope: opts.payload.scope,
          total: opts.payload.total,
          from: opts.payload.from,
          limit: opts.payload.limit,
          nextFrom: opts.payload.nextFrom,
        }),
      )
      return
    }
    if (opts.json) {
      yield* Console.log(JSON.stringify(opts.payload, null, 2))
      return
    }
    yield* Console.log(opts.text)
  })

export const exploreCommands = (
  resume: Command.Command<"resume", RootFlags, RootFlags>,
) => {
  const outline = Command.make(
    "outline",
    { format: formatArg, ref: refArg, from: fromFlag, limit: limitFlag, agent: agentFlag },
    Effect.fn("cli.outline")(function* ({ format, ref, from, limit, agent }) {
      const root = yield* resume
      const agentId = Option.getOrUndefined(agent)
      const source = yield* openForExplore(format, ref, {
        cwd: Option.getOrUndefined(root.cwd),
        agentId,
        maxToolChars: Option.getOrUndefined(root.maxToolChars),
      })
      const refused = refuseScope(source)
      if (refused) {
        yield* Console.log(refused)
        return
      }
      const requests = userRequestIndexes(source.turns)
      const requestPage = windowOf(requests, from, limit, PAGE_LIMIT_MAX)
      const boundaries = boundaryIndexes(source.turns).slice(0, 30)
      const agents =
        agentId === undefined
          ? yield* listExploreAgents(format, ref, { cwd: Option.getOrUndefined(root.cwd) })
          : []
      const header = [
        `scope:    ${source.scope}`,
        `path:     ${source.path}`,
        ...(source.title ? [`title:    ${source.title}`] : []),
        `turns:    ${source.turns.length}`,
        ...(agentId === undefined ? [`agents:   ${agents.length}`] : []),
        `warnings: ${source.warnings.length}`,
        ...source.warnings.map((warning) => `- [${warning.code}] ${warning.message}`),
        "",
        "boundaries:",
        ...(boundaries.length === 0
          ? ["- (none)"]
          : boundaries.map((index) => `- ${pageLine(index, source.turns[index]!)}`)),
        "",
        `user requests ${requestPage.from}-${requestPage.from + requestPage.items.length} of ${requestPage.total}:`,
        ...requestPage.items.map((index) => pageLine(index, source.turns[index]!)),
      ]
      const base = resumeCmd("outline", format, ref, {
        cwd: Option.getOrUndefined(root.cwd),
        agentId,
      })
      const next =
        requestPage.nextFrom === null
          ? null
          : `${base} --from ${requestPage.nextFrom} --limit ${requestPage.limit}`
      const text = [
        ...header,
        "",
        pageFooter(
          next,
          requestPage.clamped ? `limit clamped to ${PAGE_LIMIT_MAX}` : null,
        ),
        agentId === undefined
          ? `agents: ${resumeCmd("agents", format, ref, { cwd: Option.getOrUndefined(root.cwd) })} --from 0`
          : "",
        `page:   ${resumeCmd("page", format, ref, { cwd: Option.getOrUndefined(root.cwd), agentId })} --from 0 --limit ${PAGE_LIMIT_DEFAULT}`,
      ]
        .filter((line) => line.length > 0)
        .join("\n")
      const items = requestPage.items.map((index) => ({
        index,
        kind: turnKind(source.turns[index]!),
        line: pageLine(index, source.turns[index]!),
      }))
      yield* printBounded({
        json: root.json,
        ndjson: false,
        payload: {
          scope: source.scope,
          path: source.path,
          ...(source.title !== undefined ? { title: source.title } : {}),
          total: requestPage.total,
          from: requestPage.from,
          limit: requestPage.limit,
          nextFrom: requestPage.nextFrom,
          items,
        },
        text,
      })
    }),
  ).pipe(
    Command.withDescription(
      "Map of one session: warnings, boundaries, and a page of user requests. Does not print tool output.",
    ),
  )

  const page = Command.make(
    "page",
    {
      format: formatArg,
      ref: refArg,
      from: fromFlag,
      limit: limitFlag,
      agent: agentFlag,
      ndjson: ndjsonFlag,
    },
    Effect.fn("cli.page")(function* ({ format, ref, from, limit, agent, ndjson }) {
      const root = yield* resume
      const agentId = Option.getOrUndefined(agent)
      const source = yield* openForExplore(format, ref, {
        cwd: Option.getOrUndefined(root.cwd),
        agentId,
        maxToolChars: Option.getOrUndefined(root.maxToolChars),
      })
      const refused = refuseScope(source)
      if (refused) {
        yield* Console.log(refused)
        return
      }
      const window = windowOf(source.turns, from, limit, PAGE_LIMIT_MAX)
      const lines = window.items.map((turn, offset) => pageLine(window.from + offset, turn))
      const next =
        window.nextFrom === null
          ? null
          : `${resumeCmd("page", format, ref, { cwd: Option.getOrUndefined(root.cwd), agentId })} --from ${window.nextFrom} --limit ${window.limit}`
      const items = lines.map((line, offset) => {
        const turn = window.items[offset]!
        return {
          index: window.from + offset,
          kind: turnKind(turn),
          chars: turnBody(turn).length,
          line,
        }
      })
      const text = [
        `${source.scope}  turns ${window.from}-${window.from + lines.length} of ${window.total}`,
        ...lines,
        "",
        pageFooter(next, window.clamped ? `limit clamped to ${PAGE_LIMIT_MAX}` : null),
        `read: ${resumeCmd("read", format, ref, { cwd: Option.getOrUndefined(root.cwd), agentId })} --turn <index>`,
      ].join("\n")
      yield* printBounded({
        json: root.json,
        ndjson,
        payload: {
          scope: source.scope,
          path: source.path,
          ...(source.title !== undefined ? { title: source.title } : {}),
          total: window.total,
          from: window.from,
          limit: window.limit,
          nextFrom: window.nextFrom,
          items,
        },
        text,
      })
    }),
  ).pipe(Command.withDescription("One page of turn indexes. Tool output stays behind read."))

  const read = Command.make(
    "read",
    {
      format: formatArg,
      ref: refArg,
      turn: turnFlag,
      from: fromFlag,
      chars: charsFlag,
      agent: agentFlag,
    },
    Effect.fn("cli.read")(function* ({ format, ref, turn, from, chars, agent }) {
      const root = yield* resume
      const agentId = Option.getOrUndefined(agent)
      const source = yield* openForExplore(format, ref, {
        cwd: Option.getOrUndefined(root.cwd),
        agentId,
        maxToolChars: Option.getOrUndefined(root.maxToolChars),
      })
      const refused = refuseScope(source)
      if (refused) {
        yield* Console.log(refused)
        return
      }
      const index = Math.floor(turn)
      const selected = source.turns[index]
      if (!selected || index < 0) {
        yield* Console.log(`turn ${turn} is outside 0..${Math.max(0, source.turns.length - 1)}`)
        return
      }
      const slice = sliceText(turnBody(selected), from, chars)
      const next =
        slice.nextFrom === null
          ? null
          : `${resumeCmd("read", format, ref, { cwd: Option.getOrUndefined(root.cwd), agentId })} --turn ${index} --from ${slice.nextFrom} --chars ${slice.chars}`
      const payload = {
        scope: source.scope,
        path: source.path,
        ...(source.title !== undefined ? { title: source.title } : {}),
        total: slice.total,
        from: slice.from,
        limit: slice.chars,
        nextFrom: slice.nextFrom,
        items: [
          {
            index,
            kind: turnKind(selected),
            chars: slice.total,
            text: slice.text,
          },
        ],
      }
      const text = [
        `${source.scope}  turn ${index}/${source.turns.length}  ${turnKind(selected)}`,
        `chars ${slice.from}-${slice.from + slice.text.length} of ${slice.total}`,
        "---",
        slice.text,
        "---",
        pageFooter(next, slice.clamped ? `chars clamped to ${READ_CHARS_MAX}` : null),
      ].join("\n")
      yield* printBounded({ json: root.json, ndjson: false, payload, text })
    }),
  ).pipe(Command.withDescription("Print one slice of one turn, including tool output."))

  const find = Command.make(
    "find",
    {
      format: formatArg,
      ref: refArg,
      query: queryFlag,
      from: fromFlag,
      limit: limitFlag,
      agent: agentFlag,
      ndjson: ndjsonFlag,
    },
    Effect.fn("cli.find")(function* ({ format, ref, query, from, limit, agent, ndjson }) {
      const root = yield* resume
      const agentId = Option.getOrUndefined(agent)
      const source = yield* openForExplore(format, ref, {
        cwd: Option.getOrUndefined(root.cwd),
        agentId,
        maxToolChars: Option.getOrUndefined(root.maxToolChars),
      })
      const refused = refuseScope(source)
      if (refused) {
        yield* Console.log(refused)
        return
      }
      const found = findTurns(source.turns, query, from, limit)
      const next =
        found.nextFrom === null
          ? null
          : `${resumeCmd("find", format, ref, { cwd: Option.getOrUndefined(root.cwd), agentId })} --query ${JSON.stringify(query)} --from ${found.nextFrom} --limit ${found.limit}`
      const text = [
        `${source.scope}  ${found.total} match(es) for ${JSON.stringify(query)}`,
        ...found.items.map((hit) => hit.line),
        "",
        pageFooter(next, found.clamped ? `limit clamped to ${PAGE_LIMIT_MAX}` : null),
      ].join("\n")
      yield* printBounded({
        json: root.json,
        ndjson,
        payload: {
          scope: source.scope,
          path: source.path,
          ...(source.title !== undefined ? { title: source.title } : {}),
          total: found.total,
          from: found.from,
          limit: found.limit,
          nextFrom: found.nextFrom,
          items: found.items,
        },
        text,
      })
    }),
  ).pipe(Command.withDescription("Find turns by substring and print a page of indexes."))

  const agents = Command.make(
    "agents",
    { format: formatArg, ref: refArg, from: fromFlag, limit: limitFlag, ndjson: ndjsonFlag },
    Effect.fn("cli.agents")(function* ({ format, ref, from, limit, ndjson }) {
      const root = yield* resume
      const listed = yield* listExploreAgents(format, ref, { cwd: Option.getOrUndefined(root.cwd) })
      const window = windowOf(listed, from, limit, PAGE_LIMIT_MAX)
      const lines = window.items.map((agent) => formatAgentLine(agent))
      const next =
        window.nextFrom === null
          ? null
          : `${resumeCmd("agents", format, ref, { cwd: Option.getOrUndefined(root.cwd) })} --from ${window.nextFrom} --limit ${window.limit}`
      const text = [
        `agents ${window.from}-${window.from + lines.length} of ${window.total}`,
        ...lines,
        "",
        pageFooter(next, window.clamped ? `limit clamped to ${PAGE_LIMIT_MAX}` : null),
        `open: ${resumeCmd("page", format, ref, { cwd: Option.getOrUndefined(root.cwd) })} --agent <id> --from 0`,
      ].join("\n")
      yield* printBounded({
        json: root.json,
        ndjson,
        payload: {
          scope: "agents",
          path: ref,
          total: window.total,
          from: window.from,
          limit: window.limit,
          nextFrom: window.nextFrom,
          items: window.items,
        },
        text,
      })
    }),
  ).pipe(
    Command.withDescription(
      "List subagents from metadata. Does not decode their transcripts.",
    ),
  )

  return [outline, page, read, find, agents] as const
}

export type { FormatId }
