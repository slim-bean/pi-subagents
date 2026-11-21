# AGENTS.md

pi-subagents: persistent research subagents for pi. Read `README.md` first; it
is the behavior contract. Entry: `src/index.ts`.

## Verify changes

```bash
npm run typecheck && npm test && npm run test:pi
npm run test:fleet -- ~/projects/discussions/general   # after changing startup, roles or other fleet extensions
```

- **Never launch pi against the user's real agent directory or auth file.** It
  can trigger a 1Password prompt that blocks you and interrupts them. Tests use
  `test/helpers/harness.ts`: temporary HOME and `PI_CODING_AGENT_DIR`, empty
  auth store, scripted local provider, offline.
- A test that starts a process must end it in `finally`; a leaked child keeps
  the test runner alive.
- pi renames its process, so `ps` shows no arguments. Find subagent processes
  by parent pid.

## Invariants

- **The session file is the subagent.** Processes are a cache. Anything needed
  to resume must be in the session JSONL or the registry record, never only in
  memory.
- **One writer per session file.** Take the lock before starting a child; end
  the child before the foreground opens the file (`Supervisor.release`). Never
  append to a session from the requester's process after seeding it.
- **Role comes from the session**, via the identity entry (`role.ts`), not from
  process flags. Subagent sessions get the research instructions and never the
  `subagent_*` tools, in a child process and when a person enters them.
- **The research instructions must not vary between runs** of a subagent
  (`prompt.ts`): per-assignment data goes in the assignment message, or the
  provider prompt cache is lost on every run.
- **Children are not detached** (`rpc.ts`). They stay in the terminal's session
  so terminal close reaches them and secret managers treat them like the parent.
  Shutdown is: close stdin, then SIGTERM, then SIGKILL. Give pi time; it may be
  saving a refreshed OAuth token.
- **Nothing outlives pi.** `session_shutdown` with reason `quit` stops every
  child; the `process.on("exit")` hook in `global.ts` is the last resort. Other
  shutdown reasons (`reload`, `new`, `resume`, `fork`) must leave them running.
- **The Supervisor is process-global and holds no `pi` or `ctx`.** Extension
  instances attach in `session_start` and detach in `session_shutdown`; a stale
  context throws. `supervisor.ts` imports nothing from pi, so it stays
  unit-testable with `test/fixtures/fake-pi.mjs`.
- **No side effects in the extension factory.** No processes, timers or files
  before `session_start`.
- **A report's usage is counted once**: only the caller for whom
  `Supervisor.claim()` returns true attaches `usage` to its tool result.
- **Maintenance is disabled with the runtime-local `configure` operation.**
  `suspend` is workspace-wide and would pause the user's own sessions.
- **Do not forward credentials to children** without the user's explicit
  decision. Children authenticate like any pi process.
- The file-tool guard (`guard.ts`) is a safety net, not a security boundary.
  Do not describe subagents as sandboxed or read-only.

## Conventions

- Bump `SUPERVISOR_API` in `supervisor.ts` when the methods or events used by
  `index.ts`, `tools.ts` or `commands.ts` change shape, so a reloaded extension
  does not drive a supervisor built from older code.
- Model-facing text (tool descriptions, notices, `prompt.ts`) is part of the
  behavior. Change it deliberately and re-run `npm run test:pi`.
- Release tags follow the workspace convention: `vMAJOR.MINOR.PATCH` matching
  `package.json`.
