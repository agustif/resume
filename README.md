# resume

Standalone CLI for reading coding-agent sessions (Claude, Codex, Grok, Cursor, OpenCode, Pi) into a shared IR, then handing off or transplanting between tools.

Inspired by Grok’s `resume-session` reader, rebuilt on **Effect v4** (`Schema` codecs, services/layers, `effect/unstable/cli`).

## Status

| Format   | list | decode | handoff | transplant |
|----------|------|--------|---------|------------|
| claude   | L0   | L1     | L2      | no         |
| codex    | L0   | L1     | L2      | no         |
| grok     | L0   | L1     | L2      | no         |
| cursor   | L0   | L1     | L2      | no         |
| opencode | L0   | L1     | L2      | no         |
| pi       | L0   | L1     | L2      | no         |

In-repo fixtures under `fixtures/` drive decode→sanitize→handoff tests for every format.
Live host sessions are covered by `test/real-data.test.ts` (list→decode→handoff against real `~/.claude`, `~/.codex`, `~/.grok`, `~/.cursor`, OpenCode DB, Pi DB when present).

## Quick start

```bash
pnpm install
pnpm resume capabilities
pnpm resume list --format codex
pnpm resume show codex latest
pnpm resume handoff codex latest
pnpm resume handoff codex latest --json
```

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

## Effect reference

Optional local Effect source lives at `.repos/effect` ([Effect-TS/effect](https://github.com/Effect-TS/effect) — v4 / beta), gitignored. `pnpm prepare` clones it when missing.
