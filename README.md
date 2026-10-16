# resume

Standalone CLI for reading coding-agent sessions (Claude, Codex, Grok, Cursor, OpenCode, Pi) into a shared IR, then handing off (and eventually transplanting) between tools.

Inspired by Grok’s `resume-session` reader, rebuilt on **Effect v4** (`Schema` codecs, services/layers, `effect/unstable/cli`).

## Status

Fidelity levels: **L0** discover/list only · **L1** decode to IR · **L2** encode handoff pack · **L3** portable transplant bundle (sanitized IR + handoff files + manifest — native per-tool session files a foreign host could re-execute are out of scope) · **L4** target can natively resume with confidence (unclaimed).

| Format   | list | decode | handoff | transplant |
|----------|------|--------|---------|------------|
| claude   | L0   | L1     | L2      | L3         |
| codex    | L0   | L1     | L2      | L3         |
| grok     | L0   | L1     | L2      | L3         |
| cursor   | L0   | L1     | L2      | L3         |
| opencode | L0   | L1     | L2      | L3         |
| pi       | L0   | L1     | L2      | L3         |

`resume capabilities` prints this matrix from the adapter registry (`--json` prints it as JSON).

In-repo fixtures under `fixtures/` drive decode→sanitize→handoff tests for every format.
Live host sessions are covered by `test/real-data.test.ts` (list→decode→handoff against real `~/.claude`, `~/.codex`, `~/.grok`, `~/.cursor`, OpenCode DB, Pi DB when present; a format is skipped when the host has none).

## Install

Requires Node 22.13+ or 23.4+ (the SQLite-backed adapters use the built-in `node:sqlite`, which is flag-free only from those releases) and pnpm.

```bash
pnpm install              # installs deps; the first run also clones the Effect source to .repos/effect
pnpm build                # tsc → dist/cli/main.js
node dist/cli/main.js …   # run the built CLI
pnpm resume …             # run from source via tsx (same as pnpm dev)
```

## Quick start

```bash
pnpm resume capabilities
pnpm resume list --format codex
pnpm resume show codex latest
pnpm resume handoff codex latest
pnpm resume handoff codex latest --json
pnpm resume transplant codex latest --out /tmp/codex-handoff
pnpm resume outline claude latest --cwd /path/to/repo
pnpm resume agents claude latest --cwd /path/to/repo
pnpm resume page claude latest --cwd /path/to/repo --from 0 --limit 20
pnpm resume read claude latest --cwd /path/to/repo --turn 42 --chars 4000
pnpm resume find claude latest --cwd /path/to/repo --query "feature-flags"
pnpm resume page claude latest --cwd /path/to/repo --agent <id> --ndjson
```

## Commands

| Command | What it does |
|---------|--------------|
| `capabilities` | Fidelity matrix per adapter. |
| `list` (alias `ls`) | Local sessions, newest first. `--format <id\|all>` (default `all`), `--within-min N`, `--limit N` text rows (default 50, `0` = all). `--json` prints every ref. |
| `show <format> <ref>` | Decode to IR and print a summary: source, id, path, title/cwd/branch, turn/agent/warning counts, and the last `--turns` turns (default 8). `--json` prints the whole IR. |
| `handoff <format> <ref>` | Decode → sanitize → handoff pack. Markdown by default; `--json` prints the codec JSON. `--output <path>` writes the payload to a file instead of stdout. |
| `transplant <format> <ref> --out <dir>` | Decode → sanitize → portable bundle: `session.json` (full IR), `handoff.md`, `handoff.json`, `manifest.json`. The directory is created recursively. |
| `outline`, `page`, `read`, `find`, `agents` | Bounded exploration of large sessions — see below. |
| `index <format> <ref>` | Decode, sanitize, and chunk a session into the local hybrid index. `--recent N` indexes the N most recent instead; `--rebuild` forces re-embedding; `--skip-vectors` stores BM25 text only. |
| `search <query>` | Hybrid BM25 + local-embedding search across indexed sessions. `--format`, `--from`, `--limit` (max 40). Falls back to BM25 when Ollama is down. |

Shared flags: `--json` (`-j`), `--cwd <dir>`, `--verbose`, `--max-tool-chars N` (cap foreign tool args/results at N characters; `0` keeps full text — defaults to full for Claude, 300 elsewhere). The CLI runtime also provides `--help`, `--version`, `--completions <bash\|zsh\|fish\|sh>`, and `--log-level`.

### Session refs

`<ref>` defaults to `latest` and otherwise accepts a session id, a unique id prefix, a file/DB path, or a free-text substring matched against title, session id, and path. Ambiguous matches fail with the candidate list.

`--cwd` narrows discovery to that directory where the format records one (Claude project slug, Codex rollout `cwd`, Grok workspace, OpenCode session directory). It is a soft filter: Cursor workspace dirs are hashed, so it may not match, and Codex `.zst` rollouts (whose headers can't be read without decompressing) are retained when filtering.

## Reading big sessions

`show --json` prints the whole IR. A long Claude session, and most tool results, are larger than one model context and get truncated by the tool wrapper — use the explore commands instead. Each one prints a bounded page and a `next:` command, and re-reads the transcript on every invocation. The bound is on stdout, so a model can turn the pages.

- `outline` — warnings, boundaries, and one page of user-request indexes. No tool bodies.
- `page` — one line per turn (`index`, kind, character count, 160-character hint).
- `read --turn N` — one slice of that turn, including tool output. `--chars` default 4000, max 8000. `--from` is a character offset. In JSON, `total` / `from` / `nextFrom` are character offsets.
- `find --query` (`-q`) — case-insensitive match over the full turn text and tool output. Prints indexes, not bodies.
- `agents` — subagent id, depth, kind, and description. Claude reads `.meta.json` sidecars without decoding transcripts; Codex groups in-band agent traffic (`agent_message` routing plus `AgentMessage` hand-backs) by agent path. Other formats have no sidechain source yet, so `agents` is empty for them.
- Paging: `outline`, `page`, `find`, and `agents` take `--from` (row index) and `--limit` (default 20, clamped to 40). Every page footer names the next command.
- `--agent <id>` — on `outline`, `page`, `read`, and `find`, decode that one subagent instead of the parent. A unique prefix matches. Ambiguous ids print the candidates and do not decode. Works for Claude sidecars and Codex in-band runs; other formats report `missing-agent`.
- `--ndjson` — on `page`, `find`, and `agents`, one JSON object per line, then a `{ "type": "page", "scope", "total", "from", "limit", "nextFrom" }` trailer.
- `--json` — one JSON object for the page. `nextFrom` is the next `--from`.

Claude parent explore does not decode subagent transcripts. Pass `--agent` to open one.

## Searching across sessions

`find` is per-session substring search. For semantic search across sessions, build the local index first:

```bash
pnpm resume index grok latest                    # one session, BM25 + vectors
pnpm resume index codex latest --recent 20       # twenty most recent
pnpm resume search "mac mini setup ssh" --format grok
```

- Storage lives outside repos at `~/.local/share/resume/index/v1/` (`$XDG_DATA_HOME/resume`, overridable with `RESUME_DATA_DIR`). One JSON file per session, keyed by source-file mtime — re-running `index` refreshes only stale sessions unless `--rebuild` is passed.
- Only sanitized text is stored (same `sanitizeSession` pass as `show`/`handoff`), chunked per turn (4000 chars; 1500 chars per embedding).
- Ranking is reciprocal-rank fusion over BM25 (always) and cosine similarity over local Ollama embeddings. Vectors need Ollama on localhost with an embedding model (`RESUME_EMBED_MODEL`, default `snowflake-arctic-embed2`; host via `RESUME_OLLAMA_HOST`). Ollama down → BM25-only with a warning, never a failure.
- Hits print score, sources (`bm25`/`vector`), session, turn, and a 160-char snippet, plus an `open:` command that jumps straight to `read`.

### What Claude decode keeps

Compaction, sibling branches, and the export tail drop conversation the transcript still holds. Claude decode stitches pre-compaction messages back in timestamp order, includes sibling tool results the live leaf no longer points at, attaches `<session>/subagents/agent-*.jsonl` when `show` or `handoff` decodes the session, keeps subagent hand-backs and usage-limit notes, and inlines `tool-results/` files named by a tool result. The CLI keeps tool text in full (`maxToolChars` is a programmatic option; it defaults to 0 in adapters and 300 in raw `decodeClaudeFile`). Compact summaries, skill injections, and task-notification harness events stay out of the user-request list.

### What Codex decode keeps

Rollouts interleave conversation with execution records, and Codex decode now reads the execution half too:

- `compacted` replacement history becomes the base chain plus a `compact` boundary turn; `thread_rolled_back` drops the rolled-back turns and leaves a `rollback` boundary turn.
- `CommandExecution` items become inert `shell` tool calls with their stdout as the tool result; `Extension` items (e.g. `web.search`) become inert tool calls with result snippets.
- `task_complete` final answers become assistant turns, deduped against identical assistant text already decoded.
- In-band agent traffic (`agent_message` routing envelopes and `AgentMessage` hand-backs) groups into `SubagentRun` entries keyed by agent path, so `agents` and `--agent` work for Codex.
- Encrypted payloads, reasoning blocks, and system/developer messages stay out. Token accounts, context snapshots, and task lifecycle events are skipped silently; genuinely unknown record types are counted in `unsafe_records_skipped`.

## Safety model

- Tool calls and tool results decode as **inert** data (`inert: true`) and are never re-executed.
- `show`, `handoff`, and explore all run `sanitizeSession`: generated wrapper text is dropped or unwrapped (`<system-reminder>`, `<user_query>` bodies kept), instruction injections (`AGENTS.md`, `<INSTRUCTIONS>`), interrupt notices, skill bootstraps, and task notifications are removed, Cursor `USER:` prefixes and blob-id suffixes are stripped, and empty turns are dropped. Dropped turns are reported as `safety_dropped_turns`.
- Handoff packs carry a `safetyNote` telling the receiving agent to treat the transcript as untrusted inert history, not to execute foreign tools, and to verify repo state first.

Warnings surfaced by `show`, explore output, and packs:

| Code | Meaning |
|------|---------|
| `compaction_restored` | Pre-compaction messages the live parent chain no longer reaches were restored. |
| `parent_chain_fallback` | No parent-chain leaf found; chronological records were used. |
| `sibling_restored` | Sibling-branch messages outside the latest chain were included. |
| `persisted_output_hydrated` | Tool results were inlined from `tool-results/`. |
| `persisted_output_missing` | A `tool-results/` file named by a tool result was unreadable. |
| `subagent_decode_failed` | A Claude subagent transcript failed to decode. |
| `malformed_records_skipped` | Malformed transcript records were skipped. |
| `unsafe_records_skipped` | Foreign instruction/reasoning/context/unknown Codex items were skipped. |
| `cursor_binary_blobs_skipped` | Non-JSON Cursor blobs were skipped. |
| `cursor_limited_blob_parse` | Few or no JSON blobs were found; protobuf transcripts may be incomplete. |
| `opencode_empty_session`, `pi_empty_session` | The session held no messages. |
| `safety_dropped_turns` | Sanitize dropped generated-meta or empty turns. |

## Handoff packs

`handoff` decodes, sanitizes, and builds a bounded, lossy `HandoffPack`:

- **Markdown** sections: header (format, id, path, title/cwd/branch, turns), last user request, last assistant action, all user requests, recent turns (last 12, one line each), subagents, warnings, safety.
- **JSON** is the `HandoffPack` `Schema.toCodecJson` codec: `format`, `sessionId`, `path`, optional `title`/`cwd`/`branch`, optional `lastUserRequest`/`lastAssistantAction` (400 chars), `turnCount`, `recentTurns` (≤12 lines, 200 chars), optional `userRequests` (one line each, 300 chars), optional `subagents` (id, kind, fork/depth, last assistant text, 220 chars), `warnings`, `safetyNote`.

## Transplant bundles

`transplant <format> <ref> --out <dir>` writes a portable L3 bundle for moving a session between machines or tools as files:

- `session.json` — the full sanitized IR.
- `handoff.md` / `handoff.json` — the same renderers as `handoff`.
- `manifest.json` — `irVersion`, `format`, `sessionId`, `exportedAt`, and the file list. `session.json` round-trips through the `Session` schema.

This is portable, not native: no per-tool session files are written, and no target can auto-resume from the bundle (that is L4, unclaimed).

## What it reads

| Format | Source | Env override |
|--------|--------|--------------|
| claude | `~/.claude/projects/**/*.jsonl`; subagent transcripts and `tool-results/` under each session dir | `CLAUDE_CONFIG_DIR` |
| codex | `$CODEX_HOME` `sessions/`, `archived_sessions/`, `backup-sessions/` roots plus depth-1 top-level rollouts; `rollout-*.jsonl` and `rollout-*.jsonl.zst` | `CODEX_HOME` |
| grok | `~/.grok/sessions/<workspace>/<session>/chat_history.jsonl` (+ `summary.json` for titles) | `GROK_HOME` |
| cursor | `~/.cursor/chats/<workspace>/<session>/store.db` (SQLite) | `CURSOR_HOME` |
| opencode | `~/.local/share/opencode/opencode.db` (SQLite) | `OPENCODE_DB` (or `XDG_DATA_HOME`) |
| pi | `~/.pi/.crush/crush.db` (SQLite) | `PI_DB` |

Notes:

- Paths are relative to `$HOME` (`$USERPROFILE` fallback). Overrides replace the whole home/DB path.
- Codex discovery reads only known session roots, so a populated `workspaces/` tree (1M+ files) is never walked; a full-home walk is the last resort for unknown layouts. `.zst` rollouts are listed from file metadata (id + mtime, no title — titles need decompression) but decode fully when opened by path or ref. Newest-first ordering therefore includes compressed sessions. Codex `.zst` decompression shells to `zstd -dc`, so `zstd` must be on `PATH`.
- SQLite lists cap at 5000 rows (OpenCode, Pi); all SQLite access is read-only through Node's built-in `node:sqlite` with no native modules.
- Grok and Cursor backfill `createdAt`/`updatedAt` from transcript/store file mtime. Decoding an unknown OpenCode/Pi session id fails instead of returning an empty session. Cursor also decodes JSON-array blobs element by element.

## Architecture

- **IR** (`src/ir`) — `Schema.Class` / `TaggedClass` domain models + `Schema.toCodecJson` handoff packs
- **Core** (`src/core`) — adapter contract, `Context.Service` registry, safety (`Match`), orchestrator (`Effect.fn`)
- **Platform** (`src/platform`) — `FileSystem`/`Stream` JSONL, `Config` homes, `ChildProcess` zstd, `Ndjson`
- **Adapters** (`src/adapters/*`) — format-specific list/decode pipelines
- **CLI** (`src/cli`) — `effect/unstable/cli` with shared flags + `NodeServices` / `NodeRuntime`

Session conversion is an **Effect pipeline** (multi-pass reconstruction). Schema validates IR and wire fragments; it is not a single whole-file transform.

### Effect primitives in use

| Area | Modules |
|------|---------|
| Effects / DI | `Effect`, `Effect.fn`, `Context.Service`, `Layer` |
| Schema / codecs | `Schema.Class`, `TaggedClass`, `TaggedError`, `toCodecJson`, `decodeUnknownEffect` |
| Pattern match | `Match.valueTags` |
| Streams | `Stream`, `FileSystem.stream`, `Stream.decodeText`, `splitLines` |
| NDJSON | `effect/unstable/encoding/Ndjson` |
| Process | `effect/unstable/process` (`ChildProcess`, `ChildProcessSpawner`) for zstd |
| Config | `Config.option` / `Config.string` for agent homes |
| Time | `Clock.currentTimeMillis` for recency filters |
| Result | `Result` / `Effect.result` for soft parse failures |
| CLI | `effect/unstable/cli` (`Command`, `Flag`, `Argument`, shared flags) |
| Platform | `@effect/platform-node` (`NodeServices`, `NodeRuntime`) |

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc → dist/
pnpm test        # node:test via tsx over test/**/*.test.ts
```

Tests:

- `all-formats.test.ts` — fixture decode→sanitize→handoff for all six formats, plus the capabilities matrix
- `codex-decode.test.ts` — Codex rollout decode, including the agentic wire (boundaries, subagent runs, shell executions, dedupe)
- `codex-list.test.ts` — scoped discovery against a synthetic `$CODEX_HOME` (roots, `.zst` inclusion, `workspaces/` exclusion, cwd filter)
- `db-formats.test.ts` — unknown-id failures, empty-session warnings, mtime backfill, array blobs
- `transplant.test.ts` — bundle layout, manifest, and IR round-trip
- `claude-compaction.test.ts`, `claude-coverage.test.ts`, `claude-subagents.test.ts` — pre-compaction restore, sibling/hand-back/tool-results coverage, sidechain handling
- `explore.test.ts` — page/find/slice windows and Claude explore loading
- `search.test.ts` — BM25/RRF/cosine units, chunk bounds, index round-trip with freshness caching
- `real-data.test.ts` — live host sessions; skips a format with no local sessions and is the slowest suite (it decodes real transcripts — point env overrides at a small dir to keep it quick)

Run one suite directly: `pnpm exec tsx --test test/all-formats.test.ts`.

Adding a format: implement `SessionAdapter` (`list` + `decode`) under `src/adapters/<id>/`, register it in `src/adapters/index.ts`, declare capabilities/fidelity, and add a fixture plus a test.

## Releasing

- Version lives in two places: `package.json` (`version`) and `src/cli/main.ts` (`Command.run({ version })`). Keep them in sync.
- Gate: `pnpm typecheck && pnpm build && pnpm test` (full suite ≈ 6–10s; `real-data.test.ts` reads live host sessions).
- Smoke: `node dist/cli/main.js --help` and one command per format. Wiki examples are generated from fixtures with these same commands.
- Tag: `git tag v0.1.0 && git push origin v0.1.0`.

Optional local Effect source lives at `.repos/effect` ([Effect-TS/effect](https://github.com/Effect-TS/effect) — v4 / beta), gitignored. `pnpm prepare` (`scripts/prepare-effect.sh`) clones it when missing, which is also what the first `pnpm install` does.
