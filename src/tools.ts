/** Model-facing tools. Thin adapters over the Supervisor. */
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { THINKING_LEVELS } from "./config.ts";
import { formatCost, formatDuration, oneLine, outcomeLabel, resultHeadline, snapshotLine, titleFromTask } from "./format.ts";
import { assignmentMessage } from "./prompt.ts";
import { renderResult } from "./report.ts";
import { normalizeId } from "./store.ts";
import type { Supervisor } from "./supervisor.ts";
import {
	type AssignmentResult,
	EVENT_ENTRY,
	type Limits,
	type Requester,
	type Settings,
	type Snapshot,
	type SubagentRef,
	type UsageTotals,
	ZERO_USAGE,
} from "./types.ts";

export interface ToolHost {
	supervisor(): Supervisor;
	settings(ctx: ExtensionContext): Settings;
}

interface Details {
	/** Live progress lines while a call is waiting. */
	progress?: string[];
	results?: AssignmentResult[];
	subagents?: Snapshot[];
}

const ResultShape = Type.Object({
	id: Type.String(),
	title: Type.String(),
	state: Type.String({ description: "idle, queued, starting or running" }),
	sessionFile: Type.String(),
	outcome: Type.Optional(Type.String({ description: "completed, stopped, failed or limit" })),
	report: Type.Optional(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	reportFile: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	turns: Type.Optional(Type.Number()),
	durationMs: Type.Optional(Type.Number()),
	costUsd: Type.Optional(Type.Number()),
});
const ListShape = Type.Object({ subagents: Type.Array(ResultShape) });

const RunParams = Type.Object({
	task: Type.String({
		description:
			"Self-contained assignment. The subagent sees none of this conversation: state the question, where to look, what is already known, and what the report must contain.",
	}),
	id: Type.Optional(
		Type.String({ description: 'Existing subagent to re-engage, e.g. "s3". It keeps its earlier context. Omit to create a new subagent.' }),
	),
	title: Type.Optional(Type.String({ description: "Short label for a new subagent, a few words." })),
	background: Type.Optional(
		Type.Boolean({ description: "Return immediately instead of waiting for the report. Collect it later with subagent_wait." }),
	),
	model: Type.Optional(Type.String({ description: 'Model as "provider/model-id". Omit to use the configured default.' })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
	maxTurns: Type.Optional(Type.Number({ description: "Turn budget for this assignment. 0 removes the limit." })),
	maxMinutes: Type.Optional(Type.Number({ description: "Time budget in minutes. 0 removes the limit." })),
	maxCostUsd: Type.Optional(Type.Number({ description: "Cost budget in USD. 0 removes the limit." })),
});

const SteerParams = Type.Object({
	id: Type.String({ description: 'Running subagent, e.g. "s3".' }),
	message: Type.String({ description: "New direction. Delivered after its current tool calls, before its next model call." }),
});

const WaitParams = Type.Object({
	ids: Type.Optional(
		Type.Array(Type.String(), { description: "Subagents to wait for. Omit for every running subagent and every uncollected report." }),
	),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Stop waiting after this long; unfinished subagents keep running." })),
});

const StopParams = Type.Object({ id: Type.String({ description: 'Subagent to stop, e.g. "s3".' }) });

function requesterOf(ctx: ExtensionContext): Requester {
	return { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() };
}

function refOf(ctx: ExtensionContext, input: string): SubagentRef {
	const id = normalizeId(input);
	if (!id) throw new Error(`"${input}" is not a subagent id. Ids look like "s3"; subagent_list shows them.`);
	return { cwd: ctx.cwd, id };
}

function text(value: string) {
	return [{ type: "text" as const, text: value }];
}

function toUsage(usage: UsageTotals) {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

function addUsage(total: UsageTotals, usage: UsageTotals): UsageTotals {
	return {
		input: total.input + usage.input,
		output: total.output + usage.output,
		cacheRead: total.cacheRead + usage.cacheRead,
		cacheWrite: total.cacheWrite + usage.cacheWrite,
		totalTokens: total.totalTokens + usage.totalTokens,
		cost: total.cost + usage.cost,
	};
}

function shapeOfResult(result: AssignmentResult, report: string, truncated: boolean): Static<typeof ResultShape> {
	return JSON.parse(
		JSON.stringify({
			id: result.id,
			title: result.title,
			state: "idle",
			sessionFile: result.sessionFile,
			outcome: result.outcome,
			report,
			truncated,
			reportFile: result.reportFile,
			error: result.error,
			model: result.model,
			turns: result.turns,
			durationMs: result.durationMs,
			costUsd: result.usage.cost,
		}),
	);
}

function shapeOfSnapshot(snapshot: Snapshot): Static<typeof ResultShape> {
	const assignment = snapshot.assignment;
	return JSON.parse(
		JSON.stringify({
			id: snapshot.id,
			title: snapshot.title,
			state: snapshot.state,
			sessionFile: snapshot.sessionFile,
			outcome: snapshot.state === "idle" ? assignment?.outcome : undefined,
			model: snapshot.model,
			turns: assignment?.turns,
			durationMs: snapshot.elapsedMs,
			costUsd: snapshot.state === "idle" ? assignment?.usage.cost : snapshot.costSoFar,
		}),
	);
}

function progressLines(snapshots: Snapshot[], tail = 6): string[] {
	const lines: string[] = [];
	const single = snapshots.length === 1;
	for (const snapshot of snapshots) {
		// With one subagent there is room for its recent tool calls; otherwise one line each.
		lines.push(snapshotLine(snapshot, { activity: !single }));
		if (single) for (const line of snapshot.activity.slice(-tail)) lines.push(`  ${line}`);
	}
	return lines;
}

/** Coalesce bursts of supervisor changes into at most a few progress updates per second. */
function throttle(run: () => void, ms = 200): { call(): void; cancel(): void } {
	let timer: NodeJS.Timeout | undefined;
	return {
		call() {
			if (timer) return;
			timer = setTimeout(() => {
				timer = undefined;
				run();
			}, ms);
			timer.unref?.();
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

// ---- rendering ----------------------------------------------------------

function renderDetails(result: AgentToolResult<Details>, expanded: boolean, theme: Theme): Text {
	const details = result.details ?? {};
	if (details.progress) return new Text(details.progress.map((line) => theme.fg("dim", line)).join("\n"), 0, 0);
	if (details.results && details.results.length > 0) {
		const blocks = details.results.map((item) => {
			const color = item.outcome === "completed" ? "success" : item.outcome === "failed" ? "error" : "warning";
			const head = theme.fg(color, resultHeadline(item));
			const body = item.report.trim() || item.error || "(no report)";
			const lines = body.split("\n");
			const shown = expanded ? lines : lines.slice(0, 8);
			const more = lines.length > shown.length ? theme.fg("dim", `\n… ${lines.length - shown.length} more lines`) : "";
			return `${head}\n${theme.fg("toolOutput", shown.join("\n"))}${more}`;
		});
		return new Text(blocks.join("\n\n"), 0, 0);
	}
	const first = result.content.find((part) => part.type === "text");
	return new Text(first?.type === "text" ? first.text : "", 0, 0);
}

const renderers = {
	renderResult: (result: AgentToolResult<Details>, options: { expanded: boolean }, theme: Theme) =>
		renderDetails(result, options.expanded, theme),
};

export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
	const audit = (event: string, data: Record<string, unknown>) => {
		try {
			pi.appendEntry(EVENT_ENTRY, { event, at: Date.now(), ...data });
		} catch {
			// The audit trail is best effort.
		}
	};

	/** Build the tool result for finished assignments, claiming each report so its usage is counted once. */
	const finished = (
		supervisor: Supervisor,
		cwd: string,
		results: AssignmentResult[],
		settings: Settings,
		/** Tools about one subagent return its shape directly; subagent_wait returns a list. */
		list?: { lines: string[]; shapes: Array<Static<typeof ResultShape>> },
	): AgentToolResult<Details> => {
		let usage: UsageTotals | undefined;
		const parts: string[] = [...(list?.lines ?? [])];
		const shapes = [...(list?.shapes ?? [])];
		for (const result of results) {
			// Only the first delivery of a report adds its cost to this session's totals.
			if (supervisor.claim({ cwd, id: result.id }, result.n)) usage = addUsage(usage ?? ZERO_USAGE, result.usage);
			const rendered = renderResult(result, settings.reportMaxChars);
			parts.push(rendered.text);
			shapes.push(shapeOfResult(result, rendered.text, rendered.truncated));
		}
		return {
			content: text(parts.join("\n\n---\n\n")),
			details: { results },
			structuredContent: list ? { subagents: shapes } : shapes[0],
			usage: usage ? toUsage(usage) : undefined,
			isError: results.length > 0 && results.every((result) => result.outcome === "failed"),
		};
	};

	pi.registerTool({
		name: "subagent_run",
		label: "Subagent",
		description:
			"Delegate an investigation to a subagent: a separate pi session with its own context window and the same tools (files, shell, MCP, memory, browser). " +
			"It does the bulky reading and returns a short report with evidence; its intermediate work never enters your context. " +
			"Subagents persist: pass `id` to give an existing one a follow-up and it continues with everything it already learned. " +
			"Waits for the report unless `background` is true. Several calls in one turn run in parallel.",
		promptSnippet: "Delegate reading-heavy research to persistent subagents that report back",
		promptGuidelines: [
			"Use subagent_run for open-ended or reading-heavy research (large codebases, long threads, many documents) when you need conclusions rather than the raw material. For a known set of mechanical calls, use codemode or direct tools.",
			"A subagent report is a claim to verify, not ground truth. Check findings you rely on against the evidence it cites; its session file is a normal pi session you can read.",
			"For a follow-up on the same topic, re-engage the existing subagent by id instead of starting a new one.",
		],
		parameters: RunParams,
		outputSchema: ResultShape,
		renderCall: (args, theme) => {
			const target = args.id ? theme.fg("accent", args.id) : theme.fg("accent", "new");
			const label = args.title ?? titleFromTask(args.task ?? "");
			const mode = args.background ? theme.fg("muted", " (background)") : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("subagent_run "))}${target} ${theme.fg("dim", oneLine(label, 80))}${mode}`, 0, 0);
		},
		...renderers,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const supervisor = host.supervisor();
			const settings = host.settings(ctx);
			const requester = requesterOf(ctx);
			if (!params.task.trim()) throw new Error("task is empty");

			let ref: SubagentRef;
			if (params.id) {
				ref = refOf(ctx, params.id);
			} else {
				const own = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const model = params.model ?? settings.model ?? own;
				// Inherit the requester's thinking level only together with its model.
				const thinking = (params.thinking as string | undefined) ?? settings.thinking ?? (model === own ? ctx.thinkingLevel : undefined);
				const record = supervisor.create({
					cwd: ctx.cwd,
					title: oneLine(params.title?.trim() || titleFromTask(params.task), 60),
					requester,
					sessionDir: ctx.sessionManager.getSessionDir(),
					model,
					thinking,
				});
				ref = { cwd: record.cwd, id: record.id };
				audit("created", { id: record.id, title: record.title, sessionFile: record.sessionFile, model });
			}

			const limit = (value: number | undefined, fallback: number) =>
				typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
			const limits: Limits = {
				maxTurns: limit(params.maxTurns, settings.limits.maxTurns),
				maxMinutes: limit(params.maxMinutes, settings.limits.maxMinutes),
				maxCostUsd: limit(params.maxCostUsd, settings.limits.maxCostUsd),
			};
			const n = (supervisor.snapshot(ref)?.assignments ?? 0) + 1;
			const started = supervisor.start(ref, {
				task: params.task,
				message: assignmentMessage(params.task, n, limits),
				requester,
				background: !!params.background,
				limits,
				trusted: ctx.isProjectTrusted(),
				model: params.id ? params.model : undefined,
				thinking: params.id ? (params.thinking as string | undefined) : undefined,
			});
			const { record } = started;
			audit("assigned", { id: record.id, n: started.assignment.n, background: !!params.background, task: oneLine(params.task, 300) });

			if (params.background) {
				started.done.catch(() => {});
				const snapshot = supervisor.snapshot(ref)!;
				return {
					content: text(
						`Started ${record.id} "${record.title}" in the background (assignment ${started.assignment.n}, ${record.model ?? "default model"}).\n` +
							`Session: ${record.sessionFile}\n` +
							"Call subagent_wait to collect its report; a notice arrives when it finishes.",
					),
					details: { subagents: [snapshot] },
					structuredContent: shapeOfSnapshot(snapshot),
				};
			}

			const update = throttle(() => {
				const snapshot = supervisor.snapshot(ref);
				if (!snapshot) return;
				const lines = progressLines([snapshot]);
				onUpdate?.({ content: text(lines.join("\n")), details: { progress: lines } });
			});
			const onAbort = () => void supervisor.stop(ref);
			supervisor.on("change", update.call);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const result = await started.done;
				return finished(supervisor, ctx.cwd, [result], settings);
			} finally {
				update.cancel();
				supervisor.off("change", update.call);
				signal?.removeEventListener("abort", onAbort);
			}
		},
	});

	pi.registerTool({
		name: "subagent_steer",
		label: "Steer subagent",
		description:
			"Redirect a running subagent without restarting it: narrow the question, add a lead, or tell it to stop and report. " +
			"The message arrives after its current tool calls. For an idle subagent, use subagent_run with its id instead.",
		parameters: SteerParams,
		renderCall: (args, theme) =>
			new Text(`${theme.fg("toolTitle", theme.bold("subagent_steer "))}${theme.fg("accent", args.id ?? "")} ${theme.fg("dim", oneLine(args.message ?? "", 80))}`, 0, 0),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ref = refOf(ctx, params.id);
			await host.supervisor().steer(ref, params.message);
			audit("steered", { id: ref.id, message: oneLine(params.message, 300) });
			return { content: text(`Sent to ${ref.id}. It will see the message before its next model call.`), details: {} };
		},
	});

	pi.registerTool({
		name: "subagent_wait",
		label: "Wait for subagents",
		description:
			"Wait for background subagents to finish and return their reports. With no ids, covers every running subagent in this project and every report not yet collected. " +
			"Returns immediately for subagents that already finished.",
		parameters: WaitParams,
		outputSchema: ListShape,
		renderCall: (args, theme) =>
			new Text(`${theme.fg("toolTitle", theme.bold("subagent_wait "))}${theme.fg("accent", (args.ids ?? []).join(" ") || "all")}`, 0, 0),
		...renderers,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const supervisor = host.supervisor();
			const settings = host.settings(ctx);
			const explicit = params.ids && params.ids.length > 0;
			const me = requesterOf(ctx).sessionId;
			const refs: SubagentRef[] = explicit
				? params.ids!.map((id) => refOf(ctx, id))
				: supervisor
						.list(ctx.cwd)
						.filter(
							(snapshot) =>
								snapshot.state !== "idle" ||
								(!!snapshot.assignment?.outcome && !snapshot.assignment.collected && snapshot.assignment.requester.sessionId === me),
						)
						.map((snapshot) => ({ cwd: ctx.cwd, id: snapshot.id }));
			if (refs.length === 0) {
				return { content: text("No subagents are running and no reports are waiting."), details: {}, structuredContent: { subagents: [] } };
			}

			const update = throttle(() => {
				const snapshots = refs.map((ref) => supervisor.snapshot(ref)).filter((s): s is Snapshot => !!s && s.state !== "idle");
				if (snapshots.length === 0) return;
				const lines = progressLines(snapshots);
				onUpdate?.({ content: text(lines.join("\n")), details: { progress: lines } });
			});
			supervisor.on("change", update.call);
			let entries: Awaited<ReturnType<Supervisor["wait"]>>;
			try {
				const seconds = params.timeoutSeconds;
				entries = await supervisor.wait(refs, {
					timeoutMs: typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined,
					signal,
				});
			} finally {
				update.cancel();
				supervisor.off("change", update.call);
			}

			const lines: string[] = [];
			const shapes: Array<Static<typeof ResultShape>> = [];
			const results: AssignmentResult[] = [];
			for (const entry of entries) {
				if (!entry.record) {
					lines.push(`${entry.ref.id}: no such subagent in this project.`);
				} else if (entry.running) {
					const snapshot = supervisor.snapshot(entry.ref)!;
					lines.push(`Still working: ${snapshotLine(snapshot)}`);
					shapes.push(shapeOfSnapshot(snapshot));
				} else if (entry.result) {
					results.push(entry.result);
				} else {
					lines.push(`${entry.ref.id}: has not been given an assignment yet.`);
				}
			}
			return finished(supervisor, ctx.cwd, results, settings, { lines, shapes });
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "List subagents",
		description:
			"List this project's subagents with their state, latest assignment, cost and session file. Use it to find a subagent to re-engage.",
		parameters: Type.Object({}),
		outputSchema: ListShape,
		renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("subagent_list")), 0, 0),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const all = host.supervisor().list(ctx.cwd);
			if (all.length === 0) {
				return { content: text("No subagents in this project yet."), details: {}, structuredContent: { subagents: [] } };
			}
			// Everything active, plus the most recently used idle ones.
			const recent = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
			const shown = all.filter((snapshot) => snapshot.state !== "idle" || recent.includes(snapshot));
			const lines = shown.map((snapshot) => {
				const assignment = snapshot.assignment;
				const spent = assignment ? ` · ${assignment.turns} turns · ${formatCost(assignment.usage.cost)}` : "";
				const age = assignment?.endedAt ? ` · ${formatDuration(Date.now() - assignment.endedAt)} ago` : "";
				const status = snapshot.state === "idle" ? (assignment ? outcomeLabel(assignment) : "new") : snapshot.state;
				return `${snapshot.id} · ${status} · "${snapshot.title}" · ${snapshot.assignments} assignment(s)${spent}${age} · ${snapshot.model ?? "default model"}\n  session: ${snapshot.sessionFile}`;
			});
			if (shown.length < all.length) lines.push(`(${all.length - shown.length} older subagents not shown)`);
			return {
				content: text(lines.join("\n")),
				details: { subagents: shown },
				structuredContent: { subagents: shown.map(shapeOfSnapshot) },
			};
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Stop subagent",
		description:
			"Abort a subagent's current assignment. Its session and everything it learned are kept, so it can be re-engaged later. Returns whatever it had reported so far.",
		parameters: StopParams,
		outputSchema: ResultShape,
		renderCall: (args, theme) => new Text(`${theme.fg("toolTitle", theme.bold("subagent_stop "))}${theme.fg("accent", args.id ?? "")}`, 0, 0),
		...renderers,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const supervisor = host.supervisor();
			const ref = refOf(ctx, params.id);
			const result = await supervisor.stop(ref);
			if (!result) {
				const snapshot = supervisor.snapshot(ref);
				if (!snapshot) throw new Error(`No subagent ${ref.id} in this project.`);
				return { content: text(`${ref.id} is not running.`), details: {}, structuredContent: shapeOfSnapshot(snapshot) };
			}
			audit("stopped", { id: ref.id, n: result.n });
			return finished(supervisor, ctx.cwd, [result], host.settings(ctx));
		},
	});
}
