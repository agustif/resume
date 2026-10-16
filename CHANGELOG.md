# Changelog

## 0.1.0 — first release

Initial standalone `resume` CLI: read coding-agent sessions (Claude, Codex, Grok, Cursor, OpenCode, Pi) into a shared Effect Schema IR, then hand off, transplant, explore, or search them.

- **list / show / handoff** for all six formats (L0/L1/L2); fidelity matrix via `resume capabilities`.
- **Explore commands** (`outline`, `page`, `read`, `find`, `agents`) with bounded paging, `--agent` subagent scoping, and `--ndjson` output.
- **Transplant bundles** (L3): `session.json` + `handoff.md`/`handoff.json` + `manifest.json` via `resume transplant --out`.
- **Hybrid search**: `resume index` builds a local per-session index (sanitized text only); `resume search` fuses BM25 with local Ollama embeddings (BM25-only fallback).
- **Codex depth**: scoped session-root discovery incl. `.zst`, compaction/rollback boundaries, shell and extension executions as tool turns, `task_complete` answers, in-band agent traffic as subagent runs.
- **Safety**: foreign tools decode as inert data and are never re-executed; generated wrappers are stripped with `safety_dropped_turns` accounting; handoff packs carry an untrusted-history safety note.
- CLI flags: shared `--json`/`--cwd`/`--verbose`/`--max-tool-chars`, plus `list --limit`, `show --turns`, `handoff --output`, `index --recent/--rebuild/--skip-vectors`, `search --format/--from/--limit`.
