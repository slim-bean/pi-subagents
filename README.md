# pi-subagents

Persistent research subagents for [pi](https://pi.dev). The main agent hands an
investigation to a subagent, usually on a cheaper model. The subagent does the
bulky reading in its own context window and returns a short report with
evidence. Only the report enters the main context.

A subagent is a normal pi session:

- **Durable.** Its transcript is a session JSONL next to your other sessions,
  linked to the session that created it (it nests under that session in `/resume`).
- **Re-engageable.** Give it a follow-up days later and it continues with
  everything it already learned.
- **Enterable.** `/subagents enter s3` switches your terminal into its session,
  where `/tree`, scrolling and chatting work as usual.
- **Fully equipped.** It loads your normal pi configuration, so MCP servers,
  memory, session search and browser tools work as they do for you.

Scope: research and reconnaissance. Subagents are told not to change things,
and their `write`/`edit` tools are limited to their own directory and the temp
directory. This is not a sandbox; see [Limits of the design](#limits-of-the-design).

## Install

```sh
pi install git:github.com/slim-bean/pi-subagents
```

To pin this release, use `git:github.com/slim-bean/pi-subagents@v0.3.0`. Pinned
refs do not move; select a new tag explicitly to upgrade. Run `/reload` in
already-running sessions. To try it for one run without installing:

```sh
pi -e git:github.com/slim-bean/pi-subagents
```

Install it globally, not per project: subagent processes read the same
settings as the session that starts them and need the extension too. Use only
one installation source; remove a local-checkout entry before switching to the
Git install, rather than loading both copies.

Requires Node 22.19+ and macOS or Linux. There are no runtime dependencies and
no build step. Developed and tested against pi 1.5.2.

For development, clone the repository, run `npm install`, and register the
checkout with `pi install .`.

## Use

Ask the agent to delegate, or let it decide:

> Use subagents to find out how auth works in the gateway and in the API
> server, then compare the two.

| Tool | Purpose |
|---|---|
| `subagent_run` | Give a task to a new subagent, or a follow-up to an existing one (`id`). Waits for the report, or returns at once with `background: true`. Several calls in one turn run in parallel. |
| `subagent_steer` | Redirect a running subagent. |
| `subagent_wait` | Collect reports from background subagents. |
| `subagent_list` | State, latest assignment, cost and session file of each subagent in the project. |
| `subagent_stop` | Abort the current assignment. The session is kept. |

All five are callable from codemode (`tools.subagent_run(...)`) and return
structured results there. The model drills into a transcript with
`session_read` on the session path each result includes.

```
/subagents                     list this project's subagents
/subagents enter <id>          switch into a subagent's session
/subagents return              switch back to where you entered from
/subagents logs <id> [lines]   recent activity of its current or last assignment
/subagents send <id> <text>    redirect it if running, otherwise start a background assignment
/subagents stop <id>           abort its current assignment
/subagents stopall             abort every running assignment in this project
/subagents notify [mode]       how finished background work reaches the agent: interrupt | next | off
/subagents forget <id>         remove it from the list (its session file is kept)
/subagents settings            view and change settings (saved to subagents.json)
```

Running subagents appear in a widget above the editor. Esc during a waiting
`subagent_run` stops that assignment; background assignments keep going.

Ids (`s1`, `s2`, …) are per project directory, and any session in that project
can re-engage any of its subagents.

## Settings

`~/.pi/agent/subagents.json`, overridden by `<project>/.pi/subagents.json` in
trusted projects. Every key is optional; edits apply on the next use.

`/subagents settings` opens a menu of these settings. Picking one changes it
and saves it at once, to the global file or, after switching the target in the
menu, to the project file. It then prints the effective settings. You can also
edit the files by hand:

```json
{
  "model": "anthropic/claude-haiku-5-5",
  "thinking": "low",
  "maxConcurrent": 4,
  "idleMinutes": 10,
  "limits": { "maxTurns": 80, "maxMinutes": 45, "maxCostUsd": 5 },
  "reportMaxChars": 20000,
  "notify": "interrupt",
  "readOnly": true,
  "forwardAuth": []
}
```

- `model`: default for new subagents. Unset, a subagent uses the requesting
  session's current model and thinking level. `subagent_run` can override it per call.
- `limits`: per assignment; `0` disables one. Near a limit the subagent is told
  to wrap up and report; at the limit it is aborted and the requester is told to
  follow up. `subagent_run` accepts per-call values.
- `idleMinutes`: how long an idle subagent's process stays warm before it exits.
- `maxConcurrent`: further assignments queue.

### Models and credentials

Each subagent process authenticates the way any pi process does. At startup pi
runs the key command of **every** stored credential whose key is a command
(`"key": "!op read …"`), whichever model is selected. So each new subagent
process runs those commands, and a secret manager may prompt or stall, even
when the subagent uses an OAuth or local model.

To avoid that, let the requesting pi hand its already-resolved keys to the
subagent. Two steps:

1. In `~/.pi/agent/auth.json`, put the helper in front of each key command.
   Everything after `--` is your existing command, unchanged:

   ```json
   "openai": {
     "type": "api_key",
     "key": "!/path/to/pi-subagents/bin/pi-subagent-key openai -- op read 'op://…'"
   }
   ```

   `/subagents settings` prints the helper's full path for your installation
   (a Git install lives under `~/.pi/agent/git/`). If you later switch between
   a Git install and a local checkout, update the path.

   The first argument must be the provider name the entry is stored under.
   For a command with pipes or `;`, wrap it: `-- sh -c '…'`.

2. List those providers in `subagents.json`:

   ```json
   { "forwardAuth": ["openai", "anthropic-apikey"] }
   ```

How it works: when a subagent process starts, the requester puts each listed
key into a one-shot named pipe in a private temp directory and tells the child
where it is (`PI_SUBAGENT_KEYS`). The helper reads the key from the pipe
instead of running your command. Once the child has started, the pipes are
removed. Outside a subagent the helper finds no pipe and runs your command as
before, so your own pi sessions are unaffected.

The key is never in the child's environment or arguments, in a regular file,
or in a session, report or tool result. It can be read once, during startup,
before the subagent runs any tool. `/subagents settings` shows the helper path
and the forwarded providers. List only API-key providers, not OAuth ones.
If the handoff fails for any reason, the child falls back to your command.

## How it works

**A subagent is its session file; its process is disposable.** Each assignment
runs in a child `pi --mode rpc` process on the subagent's session. After
`idleMinutes` the process exits. The next assignment starts pi on the same
file, with its context restored from the transcript. Quitting pi stops all
subagent processes; nothing runs or spends unattended.

- **Creation.** The session file is seeded before the first run with a
  `parentSession` header, a display name (`subagent s3: <title>`) and an identity
  entry. The role travels with the file: a child process and a person who opens
  the session both get the research instructions, and neither gets the
  `subagent_*` tools, so subagents cannot nest.
- **Reports.** The subagent's final message of an assignment is the report. It
  is saved under the subagent's directory and returned inline, capped at
  `reportMaxChars` (start and end kept, with a pointer to the full file).
- **Cost.** A subagent's usage is attached to the tool result that delivers its
  report, so the requester's session totals include it. Each subagent session
  also keeps its own totals.
- **One writer.** A lock names the process that owns a subagent's session:
  the pi running it, or the pi where a person has entered it. Entering ends the
  subagent's process first. pi itself does not honor the lock, so opening a
  running subagent's session through `/resume` in another pi is still unsafe.
- **Survival.** Subagents keep working across `/reload` and session switches in
  the requesting pi. Reports that finish while their requester session is not
  active are announced when it is next opened.
- **Dialogs.** Nobody answers a subagent's extension dialogs; they are
  cancelled and noted in its activity log.

Files (under `PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

```
subagents/--<project path>--/s3.json        registry record: title, model, assignments, usage
subagents/--<project path>--/s3/reports/    one file per assignment report
subagents/--<project path>--/s3/artifacts/  the subagent's notes and bulky evidence
sessions/--<project path>--/*.jsonl         the subagent's session, beside your own
```

Transcripts, reports and artifacts hold whatever the subagent read. Treat them
like your own session files.

## Working with other extensions

- Subagent processes set `PI_SUBAGENT_ID` (and `PI_SUBAGENT_DIR`). Extensions
  that should behave differently inside a subagent can check it.
- **pi-session-maintenance**: idle maintenance is switched off for the runtime
  of a subagent session (child process or entered), through its host control
  channel. Your own sessions are unaffected.
- **pi-instances**: subagents appear as instances labeled `subagent s3: <title>`.
- **pi-otlp**: each process reports its own usage; nothing is counted twice.
- **pi-session-search**: subagent sessions are indexed like any session.

## Limits of the design

- **Not a sandbox.** A subagent has your pi's authority: shell, MCP and browser
  tools are unrestricted, and the research-only rule for those is an instruction.
  Only `write`/`edit` are confined. Set `"readOnly": false` to lift that.
- **Reports are claims.** A cheaper model can be wrong. Reports cite evidence so
  the requester can check; the transcript shows what the subagent actually saw.
- **No nesting, no agent-to-agent chat, no shared-memory writes** by subagents.
- **A budget stop loses the turn in flight.** Everything before it is in the
  session; a follow-up assignment can ask for a write-up.
- **A blocked subagent cannot ask.** A login or approval it needs is reported
  back instead of being requested from you.

## Development

```bash
npm run typecheck
npm test              # unit tests; supervisor tests use a scripted stand-in for pi
npm run test:pi       # end to end: real pi processes, scripted provider, no credentials
npm run test:fleet -- /path/to/a/project   # optional: also include that project's .pi/settings.json
```

`test:fleet` loads the extensions named in your real settings (paths only) into
an isolated HOME and runs one assignment through a requester and a child. It
reports startup time, dialogs, protocol noise and maintenance state. It does not
exercise MCP servers, real providers or the browser.

```
src/
  index.ts       role selection (requester or subagent), widget, notices, lifecycle
  supervisor.ts  processes, assignments, limits, concurrency, locks (no pi imports)
  global.ts      one supervisor per pi process, across reloads
  rpc.ts         JSONL client for one `pi --mode rpc` child
  store.ts       registry records and session locks
  seed.ts        creates a subagent's session file
  launch.ts      how the child pi is started
  tools.ts       subagent_* tools          commands.ts   /subagents
  prompt.ts      research instructions     report.ts     what the requester sees
  guard.ts       research-only file-tool guard
  auth.ts        collects resolved keys    handoff.ts    one-shot key pipes
bin/
  pi-subagent-key  key-command wrapper for auth.json
  config.ts      settings files            settings-editor.ts  /subagents settings menu
  format.ts, role.ts, types.ts
```
