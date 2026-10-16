import { Config, Effect, Option, Path } from "effect"

/**
 * Resolve agent home directories via Effect Config (env) + Path service.
 */
export const resolveHome = Effect.fn("platform.resolveHome")(function* () {
  const pathApi = yield* Path.Path
  const home = yield* Config.option(Config.string("HOME"))
  const userProfile = yield* Config.option(Config.string("USERPROFILE"))
  return Option.getOrElse(
    Option.orElse(home, () => userProfile),
    () => pathApi.join("/", "tmp"),
  )
})

export const resolveCodexHome = Effect.fn("platform.resolveCodexHome")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("CODEX_HOME"))
  if (Option.isSome(configured)) return configured.value
  const home = yield* resolveHome()
  return pathApi.join(home, ".codex")
})

export const resolveClaudeHome = Effect.fn("platform.resolveClaudeHome")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("CLAUDE_CONFIG_DIR"))
  if (Option.isSome(configured)) return configured.value
  const home = yield* resolveHome()
  return pathApi.join(home, ".claude")
})

export const resolveGrokHome = Effect.fn("platform.resolveGrokHome")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("GROK_HOME"))
  if (Option.isSome(configured)) return configured.value
  const home = yield* resolveHome()
  return pathApi.join(home, ".grok")
})

export const resolveCursorHome = Effect.fn("platform.resolveCursorHome")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("CURSOR_HOME"))
  if (Option.isSome(configured)) return configured.value
  const home = yield* resolveHome()
  return pathApi.join(home, ".cursor")
})

export const resolveOpenCodeDb = Effect.fn("platform.resolveOpenCodeDb")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("OPENCODE_DB"))
  if (Option.isSome(configured)) return configured.value
  const home = yield* resolveHome()
  // XDG-style default used by OpenCode
  const xdg = yield* Config.option(Config.string("XDG_DATA_HOME"))
  if (Option.isSome(xdg)) return pathApi.join(xdg.value, "opencode", "opencode.db")
  return pathApi.join(home, ".local", "share", "opencode", "opencode.db")
})

export const resolvePiDb = Effect.fn("platform.resolvePiDb")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("PI_DB"))
  if (Option.isSome(configured)) return configured.value
  const home = yield* resolveHome()
  return pathApi.join(home, ".pi", ".crush", "crush.db")
})

/**
 * Writable data dir for resume's own artifacts (search index).
 * Never inside a repo: XDG data home or ~/.local/share/resume.
 */
export const resolveResumeDataDir = Effect.fn("platform.resolveResumeDataDir")(function* () {
  const pathApi = yield* Path.Path
  const configured = yield* Config.option(Config.string("RESUME_DATA_DIR"))
  if (Option.isSome(configured)) return configured.value
  const xdg = yield* Config.option(Config.string("XDG_DATA_HOME"))
  if (Option.isSome(xdg)) return pathApi.join(xdg.value, "resume")
  const home = yield* resolveHome()
  return pathApi.join(home, ".local", "share", "resume")
})
