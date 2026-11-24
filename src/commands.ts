/** `/subagents`: the human's view of, and controls for, subagents. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { forwardedKeys } from "./auth.ts";
import { formatCost, formatDuration, formatLimits, oneLine, outcomeLabel, snapshotLine } from "./format.ts";
import { assignmentMessage } from "./prompt.ts";
import { editSettings } from "./settings-editor.ts";
import { normalizeId } from "./store.ts";
import type { Supervisor } from "./supervisor.ts";
import { type Identity, NOTICE_TYPE, type NotifyMode, type Settings, type Snapshot, type SubagentRef } from "./types.ts";

export interface CommandHost {
	supervisor(): Supervisor;
	settings(ctx: ExtensionContext): Settings;
	/** Problems found in the settings files. */
	problems(): string[];
	/** Set when the current session is a subagent's own session. */
	identity(): Identity | undefined;
	/** Working directory of the current session, for completions. */
	cwd(): string | undefined;
	/** Session-only override of the notify setting; undefined clears it. */
	setNotify(mode: NotifyMode | undefined): void;
}

/** Wrapper for auth.json key commands; see README "Models and credentials". */
const KEY_HELPER = fileURLToPath(new URL("../bin/pi-subagent-key", import.meta.url));

const SUBCOMMANDS = ["list", "enter", "return", "logs", "send", "stop", "stopall", "notify", "forget", "settings"] as const;
const TAKES_ID = new Set(["enter", "logs", "send", "stop", "forget"]);
const NOTIFY_MODES: NotifyMode[] = ["interrupt", "next", "off"];

const USAGE = `/subagents                     list this project's subagents
/subagents enter <id>          switch into a subagent's session (a normal pi session)
/subagents return              switch back to where you entered from
/subagents logs <id> [lines]   recent activity of its current or last assignment
/subagents send <id> <text>    redirect it if running, otherwise start a background assignment
/subagents stop <id>           abort its current assignment (the session is kept)
/subagents stopall             abort every running assignment in this project
/subagents notify [mode]       how finished background work reaches the agent: interrupt | next | off
/subagents forget <id>         remove it from the list (its session file is kept)
/subagents settings            view and change settings (saved to subagents.json)`;

function describe(snapshot: Snapshot): string {
	const assignment = snapshot.assignment;
	if (snapshot.state !== "idle") return snapshotLine(snapshot);
	const parts = [snapshot.id, assignment ? outcomeLabel(assignment) : "new", `"${oneLine(snapshot.title, 40)}"`];
	parts.push(`${snapshot.assignments} assignment${snapshot.assignments === 1 ? "" : "s"}`);
	if (assignment) parts.push(formatCost(assignment.usage.cost));
	if (assignment?.endedAt) parts.push(`${formatDuration(Date.now() - assignment.endedAt)} ago`);
	if (assignment?.background && assignment.outcome && !assignment.collected) parts.push("report ready");
	if (snapshot.model) parts.push(snapshot.model);
	return parts.join(" · ");
}

export function registerCommands(pi: ExtensionAPI, host: CommandHost): void {
	const refFor = (ctx: ExtensionContext, input: string | undefined): SubagentRef | undefined => {
		const id = input ? normalizeId(input) : undefined;
		if (!id) {
			ctx.ui.notify(input ? `"${input}" is not a subagent id (ids look like s3).` : "Which subagent? Give an id such as s3.", "warning");
			return undefined;
		}
		return { cwd: ctx.cwd, id };
	};

	const snapshotFor = (ctx: ExtensionContext, ref: SubagentRef): Snapshot | undefined => {
		const snapshot = host.supervisor().snapshot(ref);
		if (!snapshot) ctx.ui.notify(`No subagent ${ref.id} in this project.`, "warning");
		return snapshot;
	};

	async function enter(ctx: ExtensionCommandContext, input: string | undefined): Promise<void> {
		const supervisor = host.supervisor();
		const ref = refFor(ctx, input);
		const snapshot = ref && snapshotFor(ctx, ref);
		if (!ref || !snapshot) return;
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current response to finish (or press Esc) before entering a subagent.", "warning");
			return;
		}
		const current = ctx.sessionManager.getSessionFile();
		if (current === snapshot.sessionFile) {
			ctx.ui.notify(`You are already inside ${ref.id}.`, "info");
			return;
		}
		if (!existsSync(snapshot.sessionFile)) {
			ctx.ui.notify(`${ref.id}'s session file is missing: ${snapshot.sessionFile}`, "error");
			return;
		}
		const owner = supervisor.store.readLock(ref.cwd, ref.id);
		if (owner && owner.pid !== process.pid) {
			ctx.ui.notify(`${ref.id} is in use by another pi process (pid ${owner.pid}). Two writers would corrupt its session.`, "warning");
			return;
		}
		if (snapshot.state !== "idle") {
			const ok = ctx.hasUI && (await ctx.ui.confirm(`${ref.id} is ${snapshot.state}`, "Interrupt its current assignment and enter its session?"));
			if (!ok) return;
		}
		// One writer per session file: end the subagent's process before this pi opens the file.
		await supervisor.release(ref);
		const id = ref.id;
		const title = snapshot.title;
		const result = await ctx.switchSession(snapshot.sessionFile, {
			// After the switch only `next` is valid; the outer ctx is stale.
			withSession: async (next) => {
				if (current) {
					supervisor.returnTo.set(snapshot.sessionFile, {
						sessionFile: current,
						entryCount: next.sessionManager.getEntries().length,
					});
				}
				next.ui.notify(`Inside ${id} "${title}". This is its real session: /subagents return goes back.`, "info");
			},
		});
		if (result.cancelled) supervisor.returnTo.delete(snapshot.sessionFile);
	}

	async function goBack(ctx: ExtensionCommandContext): Promise<void> {
		const supervisor = host.supervisor();
		const identity = host.identity();
		if (!identity) {
			ctx.ui.notify("This session is not a subagent's session.", "info");
			return;
		}
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current response to finish (or press Esc) before returning.", "warning");
			return;
		}
		const file = ctx.sessionManager.getSessionFile();
		const origin = file ? supervisor.returnTo.get(file) : undefined;
		const target = origin?.sessionFile ?? identity.parentSessionFile;
		if (!target || !existsSync(target)) {
			ctx.ui.notify("No session to return to. Use /resume to pick one.", "warning");
			return;
		}
		const changed = origin ? ctx.sessionManager.getEntries().length > origin.entryCount : false;
		const { id, title } = identity;
		const result = await ctx.switchSession(target, {
			withSession: async (next) => {
				next.ui.notify(`Back from ${id}.`, "info");
				if (changed) {
					await next.sendMessage(
						{
							customType: NOTICE_TYPE,
							content:
								`The user worked directly in subagent ${id}'s session ("${title}"), so its context has moved on since its last report. ` +
								`If you need its current conclusions, ask it with subagent_run and id "${id}".`,
							display: true,
						},
						{ deliverAs: "nextTurn" },
					);
				}
			},
		});
		if (!result.cancelled && file) supervisor.returnTo.delete(file);
	}

	async function send(ctx: ExtensionCommandContext, input: string | undefined, message: string): Promise<void> {
		const supervisor = host.supervisor();
		const ref = refFor(ctx, input);
		const snapshot = ref && snapshotFor(ctx, ref);
		if (!ref || !snapshot) return;
		if (!message.trim()) {
			ctx.ui.notify("Nothing to send. Usage: /subagents send <id> <text>", "warning");
			return;
		}
		try {
			if (snapshot.state === "running") {
				await supervisor.steer(ref, message);
				ctx.ui.notify(`Sent to ${ref.id}; it will see it before its next model call.`, "info");
				return;
			}
			const settings = host.settings(ctx);
			const keys = await forwardedKeys(ctx, settings.forwardAuth);
			const started = supervisor.start(ref, {
				keys,
				task: message,
				message: assignmentMessage(message, snapshot.assignments + 1, settings.limits),
				requester: { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() },
				background: true,
				limits: settings.limits,
				trusted: ctx.isProjectTrusted(),
			});
			started.done.catch(() => {});
			ctx.ui.notify(`${ref.id} started assignment ${started.assignment.n} in the background.`, "info");
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
		}
	}

	pi.registerCommand("subagents", {
		description: "List and control research subagents (enter, return, logs, send, stop)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((name) => name.startsWith(parts[0] ?? "")).map((name) => ({ value: name, label: name }));
				return items.length > 0 ? items : null;
			}
			const sub = parts[0]!;
			const last = parts[parts.length - 1] ?? "";
			if (TAKES_ID.has(sub) && parts.length === 2) {
				const cwd = host.cwd();
				if (!cwd) return null;
				const items = host
					.supervisor()
					.list(cwd)
					.filter((snapshot) => snapshot.id.startsWith(last.toLowerCase()))
					.map((snapshot) => ({ value: `${sub} ${snapshot.id}`, label: describe(snapshot) }));
				return items.length > 0 ? items : null;
			}
			if (sub === "notify" && parts.length === 2) {
				const items = NOTIFY_MODES.filter((mode) => mode.startsWith(last)).map((mode) => ({ value: `notify ${mode}`, label: mode }));
				return items.length > 0 ? items : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub = "list", first, ...rest] = trimmed ? trimmed.split(/\s+/) : [];
			const supervisor = host.supervisor();
			switch (sub) {
				case "list": {
					const all = supervisor.list(ctx.cwd);
					ctx.ui.notify(all.length > 0 ? all.map(describe).join("\n") : "No subagents in this project yet.", "info");
					return;
				}
				case "enter":
					return enter(ctx, first);
				case "return":
					return goBack(ctx);
				case "logs": {
					const ref = refFor(ctx, first);
					const snapshot = ref && snapshotFor(ctx, ref);
					if (!snapshot) return;
					const count = Math.max(1, Number(rest[0]) || 40);
					const lines = snapshot.activity.slice(-count);
					ctx.ui.notify(
						lines.length > 0
							? `${describe(snapshot)}\n${lines.join("\n")}`
							: `${describe(snapshot)}\nNo activity recorded in this pi process. /subagents enter ${snapshot.id} shows the full transcript.`,
						"info",
					);
					return;
				}
				case "send": {
					// Preserve the message's own spacing: cut it out of the original argument string.
					const message = trimmed.replace(/^send\s+\S+\s*/, "");
					return send(ctx, first, message);
				}
				case "stop": {
					const ref = refFor(ctx, first);
					if (!ref || !snapshotFor(ctx, ref)) return;
					const result = await supervisor.stop(ref);
					ctx.ui.notify(result ? `${ref.id} stopped.` : `${ref.id} is not running.`, "info");
					return;
				}
				case "stopall": {
					const busy = supervisor.list(ctx.cwd).filter((snapshot) => snapshot.state !== "idle");
					await Promise.all(busy.map((snapshot) => supervisor.stop({ cwd: ctx.cwd, id: snapshot.id })));
					ctx.ui.notify(busy.length > 0 ? `Stopped ${busy.map((snapshot) => snapshot.id).join(", ")}.` : "Nothing is running.", "info");
					return;
				}
				case "notify": {
					if (!first) {
						ctx.ui.notify(`Background completions reach the agent: ${host.settings(ctx).notify}`, "info");
						return;
					}
					if (!NOTIFY_MODES.includes(first as NotifyMode)) {
						ctx.ui.notify(`Unknown mode "${first}". Use: ${NOTIFY_MODES.join(" | ")}`, "warning");
						return;
					}
					host.setNotify(first as NotifyMode);
					ctx.ui.notify(`Background completions reach the agent: ${first} (this session)`, "info");
					return;
				}
				case "forget": {
					const ref = refFor(ctx, first);
					const snapshot = ref && snapshotFor(ctx, ref);
					if (!ref || !snapshot) return;
					if (ctx.hasUI) {
						const ok = await ctx.ui.confirm(
							`Forget ${ref.id} "${snapshot.title}"?`,
							"Removes it from the list along with its saved reports and artifacts. Its session file is kept.",
						);
						if (!ok) return;
					}
					await supervisor.forget(ref);
					ctx.ui.notify(`${ref.id} forgotten. Its session remains at ${snapshot.sessionFile}`, "info");
					return;
				}
				case "settings": {
					if (ctx.hasUI) {
						const changed = await editSettings(ctx.ui, {
							agentDir: getAgentDir(),
							projectDir: ctx.isProjectTrusted() ? join(ctx.cwd, CONFIG_DIR_NAME) : undefined,
							models: [...new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`))].sort(),
						});
						// A saved notify choice replaces an earlier `/subagents notify` for this session.
						if (changed.has("notify")) host.setNotify(undefined);
					}
					const settings = host.settings(ctx);
					const lines = [
						`model: ${settings.model ?? "(the requesting session's model)"}`,
						`thinking: ${settings.thinking ?? "(default)"}`,
						`limits per assignment: ${formatLimits(settings.limits) || "none"}`,
						`max concurrent: ${settings.maxConcurrent}`,
						`idle process kept for: ${settings.idleMinutes} min`,
						`report cap: ${settings.reportMaxChars} chars`,
						`notify: ${settings.notify}`,
						`keys handed to subagents: ${settings.forwardAuth.join(", ") || "none"} (helper: ${KEY_HELPER})`,
						`subagent file tools: ${settings.readOnly ? "research-only (own directory and temp)" : "unrestricted"}`,
						...host.problems().map((problem) => `problem: ${problem}`),
					];
					ctx.ui.notify(lines.join("\n"), host.problems().length > 0 ? "warning" : "info");
					return;
				}
				default:
					ctx.ui.notify(USAGE, "info");
			}
		},
	});
}
