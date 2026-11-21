/**
 * Owns subagent processes for this pi process.
 *
 * A subagent is its session file; a process is only how an assignment gets
 * executed. Processes start on demand, stay warm for a while after an
 * assignment, and exit when idle. Re-engaging a subagent restarts pi on the
 * same session file with its context intact.
 *
 * One Supervisor lives per pi process (see getSupervisor) so subagents keep
 * running across /reload and session switches. It therefore never holds a pi
 * `ctx` or `pi` object: extension instances subscribe to its events instead.
 * No pi imports here; launching and session seeding are injected.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatToolCall, oneLine } from "./format.ts";
import { type RpcExit, type RpcLaunch, RpcProcess, type RpcRecord } from "./rpc.ts";
import type { Store } from "./store.ts";
import {
	type AssignmentRecord,
	type AssignmentResult,
	DEFAULT_SETTINGS,
	type Limits,
	type Outcome,
	type Requester,
	type RunState,
	type Settings,
	type Snapshot,
	type SubagentRecord,
	type SubagentRef,
	type UsageTotals,
	ZERO_USAGE,
} from "./types.ts";

/** Bump when the shape used by extension instances changes; see getSupervisor. */
export const SUPERVISOR_API = 1;

const ACTIVITY_LINES = 200;
const TASK_RECORD_CHARS = 4000;
/** Fraction of a limit at which the subagent is told to wrap up. */
const SOFT_LIMIT = 0.8;

export interface LaunchRequest {
	record: SubagentRecord;
	trusted: boolean;
}
export type Launcher = (request: LaunchRequest) => RpcLaunch;

export interface SeedRequest {
	id: string;
	title: string;
	cwd: string;
	/** Directory holding the subagent's reports/ and artifacts/. */
	dir: string;
	requester: Requester;
	sessionDir?: string;
}
export type Seeder = (request: SeedRequest) => { sessionFile: string; sessionId: string };

export interface CreateRequest {
	cwd: string;
	title: string;
	requester: Requester;
	sessionDir?: string;
	model?: string;
	thinking?: string;
}

export interface StartRequest {
	/** The task as the requester wrote it (kept in the registry). */
	task: string;
	/** The full prompt sent to the subagent. */
	message: string;
	requester: Requester;
	background: boolean;
	limits: Limits;
	/** Whether the requester's project is trusted; the child gets the same answer. */
	trusted: boolean;
	/** Switch the subagent to this model before the assignment. */
	model?: string;
	thinking?: string;
}

export interface Started {
	record: SubagentRecord;
	assignment: AssignmentRecord;
	done: Promise<AssignmentResult>;
}

export interface EndEvent {
	record: SubagentRecord;
	assignment: AssignmentRecord;
	result: AssignmentResult;
}

export interface WaitEntry {
	ref: SubagentRef;
	record?: SubagentRecord;
	/** Latest finished assignment, when there is one and it is not still running. */
	result?: AssignmentResult;
	/** Still working when the wait ended (timeout or cancellation). */
	running: boolean;
}

interface Active {
	rec: AssignmentRecord;
	limits: Limits;
	cost: number;
	softSent: boolean;
	stop?: "stop" | "limit";
	lastText: string;
	lastStopReason?: string;
	lastError?: string;
	dialogs: string[];
	settled: Promise<void>;
	settle: () => void;
	fail: (error: Error) => void;
	done: Promise<AssignmentResult>;
	ticker?: NodeJS.Timeout;
}

interface Runtime {
	ref: SubagentRef;
	record: SubagentRecord;
	state: RunState;
	proc?: RpcProcess;
	active?: Active;
	idleTimer?: NodeJS.Timeout;
	activity: string[];
	lastActivity?: string;
	/** Model/thinking changed since the process started; apply over RPC before the next prompt. */
	modelDirty: boolean;
}

function keyOf(ref: SubagentRef): string {
	return `${ref.cwd}\0${ref.id}`;
}

function samePath(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

function textOf(message: RpcRecord | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n")
		.trim();
}

function usageDelta(before: RpcRecord | undefined, after: RpcRecord | undefined): UsageTotals | undefined {
	if (!before?.tokens || !after?.tokens) return undefined;
	const diff = (key: string) => Math.max(0, Number(after.tokens[key] ?? 0) - Number(before.tokens[key] ?? 0));
	return {
		input: diff("input"),
		output: diff("output"),
		cacheRead: diff("cacheRead"),
		cacheWrite: diff("cacheWrite"),
		totalTokens: diff("total"),
		cost: Math.max(0, Number(after.cost ?? 0) - Number(before.cost ?? 0)),
	};
}

export class Supervisor extends EventEmitter {
	readonly api = SUPERVISOR_API;
	private runtimes = new Map<string, Runtime>();
	private settings: Settings = DEFAULT_SETTINGS;
	private barrier: Promise<unknown> = Promise.resolve();
	private slots = 0;
	private slotWaiters: Array<() => void> = [];
	/** Where `/subagents return` goes, keyed by the entered subagent's session file. */
	readonly returnTo = new Map<string, { sessionFile: string; entryCount: number }>();

	constructor(
		readonly store: Store,
		private readonly launcher: Launcher,
		private readonly seeder: Seeder,
	) {
		super();
		this.setMaxListeners(50);
	}

	configure(settings: Settings): void {
		this.settings = settings;
		for (const waiter of this.slotWaiters.splice(0)) waiter();
	}

	/** True while any child process is alive or any assignment is pending. */
	hasLiveWork(): boolean {
		for (const rt of this.runtimes.values()) if (rt.proc?.alive || rt.active) return true;
		return false;
	}

	/** True while an assignment is queued, starting or running. Warm idle processes do not count. */
	hasActiveWork(): boolean {
		for (const rt of this.runtimes.values()) if (rt.active) return true;
		return false;
	}

	/** Hold new assignments until `work` settles, e.g. while a replaced supervisor ends its processes. */
	holdUntil(work: Promise<unknown>): void {
		this.barrier = Promise.all([this.barrier, work.catch(() => undefined)]);
	}

	// ---- creation -------------------------------------------------------

	create(request: CreateRequest): SubagentRecord {
		const now = Date.now();
		const record = this.store.allocate(request.cwd, (id) => ({
			version: 1,
			id,
			title: request.title,
			cwd: request.cwd,
			createdAt: now,
			updatedAt: now,
			createdBy: request.requester,
			sessionFile: "",
			sessionId: "",
			model: request.model,
			thinking: request.thinking,
			assignments: [],
		}));
		try {
			const seeded = this.seeder({
				id: record.id,
				title: record.title,
				cwd: record.cwd,
				dir: this.store.dir(record.cwd, record.id),
				requester: request.requester,
				sessionDir: request.sessionDir,
			});
			record.sessionFile = seeded.sessionFile;
			record.sessionId = seeded.sessionId;
			this.store.save(record);
		} catch (error) {
			this.store.remove(record.cwd, record.id);
			throw error;
		}
		this.emit("change");
		return record;
	}

	private runtime(ref: SubagentRef): Runtime {
		const key = keyOf(ref);
		let rt = this.runtimes.get(key);
		if (!rt) {
			const record = this.store.load(ref.cwd, ref.id);
			if (!record) throw new Error(`No subagent ${ref.id} in this project. Use subagent_list to see the available ones.`);
			rt = { ref: { cwd: record.cwd, id: record.id }, record, state: "idle", activity: [], modelDirty: false };
			this.runtimes.set(key, rt);
		}
		return rt;
	}

	// ---- assignments ----------------------------------------------------

	start(ref: SubagentRef, request: StartRequest): Started {
		const rt = this.runtime(ref);
		if (rt.active) {
			throw new Error(
				`${ref.id} is already working on an assignment. Use subagent_steer to redirect it, or subagent_wait for its report.`,
			);
		}
		const owner = this.store.readLock(ref.cwd, ref.id);
		if (owner && (owner.pid !== process.pid || owner.kind === "foreground")) {
			throw new Error(
				owner.kind === "foreground"
					? `${ref.id}'s session is open interactively in pi (pid ${owner.pid}). Leave that session before giving it work.`
					: `${ref.id} is being run by another pi process (pid ${owner.pid}).`,
			);
		}
		// Another pi process may have used this subagent since we cached its record.
		if (!rt.proc?.alive) rt.record = this.store.load(ref.cwd, ref.id) ?? rt.record;
		const record = rt.record;
		if ((request.model && request.model !== record.model) || (request.thinking && request.thinking !== record.thinking)) {
			record.model = request.model ?? record.model;
			record.thinking = request.thinking ?? record.thinking;
			rt.modelDirty = true;
		}
		const rec: AssignmentRecord = {
			n: record.assignments.length + 1,
			task: request.task.slice(0, TASK_RECORD_CHARS),
			requester: request.requester,
			background: request.background,
			startedAt: Date.now(),
			turns: 0,
			usage: { ...ZERO_USAGE },
			collected: false,
		};
		record.assignments.push(rec);
		this.store.save(record);

		let settle!: () => void;
		let fail!: (error: Error) => void;
		const settled = new Promise<void>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		settled.catch(() => {}); // Observed in execute(); avoid an unhandled rejection if it fails first.
		const active: Active = {
			rec,
			limits: request.limits,
			cost: 0,
			softSent: false,
			lastText: "",
			dialogs: [],
			settled,
			settle,
			fail,
			done: undefined as unknown as Promise<AssignmentResult>,
		};
		rt.active = active;
		rt.activity = [];
		rt.lastActivity = undefined;
		this.setState(rt, "queued");
		active.done = this.execute(rt, active, request);
		return { record, assignment: rec, done: active.done };
	}

	private async execute(rt: Runtime, active: Active, request: StartRequest): Promise<AssignmentResult> {
		let slot = false;
		let before: RpcRecord | undefined;
		let failure: Error | undefined;
		try {
			await this.barrier;
			slot = await this.acquireSlot(active);
			if (slot && !active.stop) {
				this.setState(rt, "starting");
				const proc = await this.ensureProcess(rt, request.trusted);
				if (!active.stop) {
					before = await proc.request("get_session_stats", {}, 15_000).catch(() => undefined);
					this.setState(rt, "running");
					active.rec.startedAt = Date.now(); // Exclude queueing and process start from the budget.
					active.ticker = setInterval(() => this.checkLimits(rt, active), 5000);
					active.ticker.unref?.();
					const accepted = await proc.request<RpcRecord>("prompt", { message: request.message }, 60_000);
					if (accepted?.disposition === "handled") {
						throw new Error("the assignment was consumed by an extension command instead of reaching the model");
					}
					// A stop that raced with prompt acceptance found nothing to abort; repeat it now.
					if (active.stop) void this.abortRun(rt, active);
					await active.settled;
				}
			}
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		} finally {
			if (active.ticker) clearInterval(active.ticker);
			if (slot) this.releaseSlot();
		}
		return this.finish(rt, active, before, failure);
	}

	private async finish(rt: Runtime, active: Active, before: RpcRecord | undefined, failure?: Error): Promise<AssignmentResult> {
		const proc = rt.proc?.alive ? rt.proc : undefined;
		const [after, state] = proc
			? await Promise.all([
					proc.request("get_session_stats", {}, 15_000).catch(() => undefined),
					proc.request("get_state", {}, 15_000).catch(() => undefined),
				])
			: [undefined, undefined];

		const rec = active.rec;
		let outcome: Outcome = "completed";
		let error: string | undefined;
		if (active.stop === "limit") outcome = "limit";
		else if (active.stop === "stop") outcome = "stopped";
		else if (failure) {
			outcome = "failed";
			error = failure.message;
		} else if (active.lastStopReason === "error") {
			outcome = "failed";
			error = active.lastError ?? "the model request failed";
		} else if (active.lastStopReason === "aborted") outcome = "stopped";

		rec.endedAt = Date.now();
		rec.outcome = outcome;
		rec.error = error;
		rec.usage = usageDelta(before, after) ?? { ...ZERO_USAGE, cost: active.cost };
		if (state?.model?.provider && state.model.id) rec.model = `${state.model.provider}/${state.model.id}`;
		else rec.model = rt.record.model;

		const report = active.lastText;
		let reportFile: string | undefined;
		if (report) {
			try {
				const dir = join(this.store.dir(rt.ref.cwd, rt.ref.id), "reports");
				mkdirSync(dir, { recursive: true });
				reportFile = join(dir, `${rec.n}.md`);
				writeFileSync(reportFile, `${report}\n`, { mode: 0o600 });
			} catch {
				reportFile = undefined; // The report still reaches the requester inline.
			}
		}
		rec.reportFile = reportFile;
		rec.reportChars = report.length;
		if (active.dialogs.length > 0 && !rec.error && outcome !== "completed") {
			rec.error = `cancelled dialogs: ${active.dialogs.join("; ")}`;
		}
		try {
			this.store.save(rt.record);
		} catch {
			// Registry write failures must not lose the result.
		}

		const result: AssignmentResult = {
			id: rt.record.id,
			title: rt.record.title,
			n: rec.n,
			outcome,
			error: rec.error,
			limitHit: rec.limitHit,
			report,
			reportFile,
			sessionFile: rt.record.sessionFile,
			model: rec.model,
			turns: rec.turns,
			durationMs: rec.endedAt - rec.startedAt,
			usage: rec.usage,
		};
		rt.active = undefined;
		this.setState(rt, "idle");
		this.armIdle(rt);
		// After the promise continuations of waiters, so a waiting tool call can claim the report first.
		setImmediate(() => this.emit("end", { record: rt.record, assignment: rec, result } satisfies EndEvent));
		return result;
	}

	// ---- processes ------------------------------------------------------

	private async ensureProcess(rt: Runtime, trusted: boolean): Promise<RpcProcess> {
		this.clearIdle(rt);
		if (rt.proc?.alive) {
			await this.applyModel(rt, rt.proc);
			return rt.proc;
		}
		const lock = this.store.acquireLock(rt.ref.cwd, rt.ref.id, "child");
		if (!lock.ok) throw new Error(`${rt.ref.id} is in use by another pi process (pid ${lock.owner.pid}).`);
		const launch = this.launcher({ record: rt.record, trusted });
		const proc: RpcProcess = new RpcProcess(launch, {
			onEvent: (event) => this.onEvent(rt, event),
			onDialog: (request) => {
				const title = oneLine(String(request.title ?? request.method ?? "dialog"), 80);
				rt.active?.dialogs.push(title);
				this.note(rt, `cancelled dialog: ${title}`);
			},
			onUi: (request) => {
				const level = request.notifyType ?? request.level;
				if (request.method === "notify" && (level === "error" || level === "warning")) {
					this.note(rt, `${level}: ${oneLine(String(request.message ?? ""), 120)}`);
				}
			},
			onExit: (exit) => this.onProcessExit(rt, proc, exit),
		});
		rt.proc = proc;
		rt.modelDirty = false; // The launcher passes the current model on the command line.
		proc.start();
		this.emit("change");
		try {
			const state = await proc.request<RpcRecord>("get_state", {}, this.settings.startTimeoutSeconds * 1000);
			if (typeof state?.sessionFile === "string" && !samePath(state.sessionFile, rt.record.sessionFile)) {
				throw new Error(`pi opened ${state.sessionFile} instead of the subagent's session`);
			}
			// The command line asks for the recorded model; correct it over RPC if pi restored another.
			const running = state?.model?.provider && state.model.id ? `${state.model.provider}/${state.model.id}` : undefined;
			const wrongModel = !!rt.record.model && !!running && running !== rt.record.model;
			const wrongThinking = !!rt.record.thinking && !!state?.thinkingLevel && state.thinkingLevel !== rt.record.thinking;
			if (wrongModel || wrongThinking) {
				rt.modelDirty = true;
				await this.applyModel(rt, proc);
			}
		} catch (error) {
			await proc.shutdown(2000);
			throw new Error(`could not start the subagent process: ${(error as Error).message}`);
		}
		return proc;
	}

	private async applyModel(rt: Runtime, proc: RpcProcess): Promise<void> {
		if (!rt.modelDirty) return;
		rt.modelDirty = false;
		const model = rt.record.model;
		const slash = model?.indexOf("/") ?? -1;
		if (model && slash > 0) {
			await proc.request("set_model", { provider: model.slice(0, slash), modelId: model.slice(slash + 1) });
		}
		if (rt.record.thinking) await proc.request("set_thinking_level", { level: rt.record.thinking });
	}

	private onProcessExit(rt: Runtime, proc: RpcProcess, exit: RpcExit): void {
		if (rt.proc !== proc) return;
		rt.proc = undefined;
		this.clearIdle(rt);
		this.store.releaseLock(rt.ref.cwd, rt.ref.id);
		if (rt.active) {
			const how = exit.error ?? (exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`);
			const tail = exit.stderr.trim().split("\n").slice(-6).join("\n");
			rt.active.fail(new Error(`the subagent process exited (${how})${tail ? `:\n${tail}` : ""}`));
		}
		this.emit("change");
	}

	private onEvent(rt: Runtime, event: RpcRecord): void {
		const active = rt.active;
		switch (event.type) {
			case "tool_execution_start":
				this.note(rt, formatToolCall(String(event.toolName), event.args));
				break;
			case "message_end": {
				const message = event.message;
				if (!active || message?.role !== "assistant") break;
				const text = textOf(message);
				if (text) active.lastText = text;
				active.lastStopReason = message.stopReason;
				active.lastError = message.errorMessage;
				active.cost += Number(message.usage?.cost?.total ?? 0);
				break;
			}
			case "turn_end":
				if (!active) break;
				active.rec.turns++;
				// A turn without tool calls ends the run; the report is already in, so there is nothing to cut short.
				if (active.lastStopReason === "toolUse") this.checkLimits(rt, active);
				this.emit("change");
				break;
			case "compaction_start":
				this.note(rt, "compacting context");
				break;
			case "agent_settled":
				active?.settle();
				break;
		}
	}

	private note(rt: Runtime, line: string): void {
		rt.activity.push(line);
		if (rt.activity.length > ACTIVITY_LINES) rt.activity.splice(0, rt.activity.length - ACTIVITY_LINES);
		rt.lastActivity = line;
		this.emit("change");
	}

	private setState(rt: Runtime, state: RunState): void {
		rt.state = state;
		this.emit("change");
	}

	// ---- limits ---------------------------------------------------------

	private checkLimits(rt: Runtime, active: Active): void {
		if (active.stop || rt.state !== "running") return;
		const { maxTurns, maxMinutes, maxCostUsd } = active.limits;
		const minutes = (Date.now() - active.rec.startedAt) / 60_000;
		const over = (fraction: number): string | undefined => {
			// Leave at least two turns for writing the report, however small the budget.
			const turnMark = fraction < 1 ? Math.max(1, Math.min(Math.floor(maxTurns * fraction), maxTurns - 2)) : maxTurns;
			if (maxTurns > 0 && active.rec.turns >= turnMark) return "turns";
			if (maxCostUsd > 0 && active.cost >= maxCostUsd * fraction) return "cost";
			if (maxMinutes > 0 && minutes >= maxMinutes * fraction) return "time";
			return undefined;
		};
		const hard = over(1);
		if (hard) {
			active.rec.limitHit = hard;
			active.stop = "limit";
			this.note(rt, `limit reached (${hard}); stopping`);
			void this.abortRun(rt, active);
			return;
		}
		const soft = over(SOFT_LIMIT);
		if (soft && !active.softSent) {
			active.softSent = true;
			this.note(rt, `budget nearly used (${soft}); asked to wrap up`);
			rt.proc
				?.request("steer", {
					message:
						`Budget notice: this assignment has used most of its ${soft} budget. ` +
						"Stop investigating now and write your final report with what you have, " +
						"including what you could not verify and what remains to be done.",
				})
				.catch(() => {});
		}
	}

	private async abortRun(rt: Runtime, active: Active): Promise<void> {
		const proc = rt.proc;
		if (proc?.alive) await proc.request("abort", {}, 30_000).catch(() => {});
		// `abort` answers once pi is idle. agent_settled normally arrives first; cover a missed event.
		const timer = setTimeout(() => active.settle(), 2000);
		timer.unref?.();
	}

	private async acquireSlot(active: Active): Promise<boolean> {
		while (!active.stop && this.slots >= Math.max(1, this.settings.maxConcurrent)) {
			await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
		}
		if (active.stop) return false;
		this.slots++;
		return true;
	}

	private releaseSlot(): void {
		this.slots = Math.max(0, this.slots - 1);
		// Wake everyone; each re-checks capacity. Waiting sets are tiny.
		for (const waiter of this.slotWaiters.splice(0)) waiter();
	}

	// ---- control --------------------------------------------------------

	/** Redirect a running subagent. Delivered after its current tool calls, before its next model call. */
	async steer(ref: SubagentRef, message: string): Promise<void> {
		const rt = this.runtimes.get(keyOf(ref));
		if (!rt?.active || rt.state !== "running" || !rt.proc?.alive) {
			throw new Error(`${ref.id} is not running. Give it a new assignment with subagent_run instead.`);
		}
		await rt.proc.request("steer", { message });
		this.note(rt, `steered: ${oneLine(message, 80)}`);
	}

	/** Abort the current assignment. The session and everything learned so far are kept. */
	async stop(ref: SubagentRef): Promise<AssignmentResult | undefined> {
		const rt = this.runtimes.get(keyOf(ref));
		const active = rt?.active;
		if (!rt || !active) return undefined;
		if (!active.stop) active.stop = "stop";
		if (rt.state === "queued") {
			for (const waiter of this.slotWaiters.splice(0)) waiter();
		} else if (rt.state === "running") {
			void this.abortRun(rt, active);
		}
		return active.done;
	}

	/**
	 * Wait for the listed subagents to finish their current assignments, then
	 * return each one's latest finished assignment.
	 */
	async wait(refs: SubagentRef[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WaitEntry[]> {
		const pending = refs
			.map((ref) => this.runtimes.get(keyOf(ref))?.active?.done)
			.filter((done): done is Promise<AssignmentResult> => !!done)
			.map((done) => done.catch(() => undefined));
		if (pending.length > 0) {
			let timer: NodeJS.Timeout | undefined;
			let onAbort: (() => void) | undefined;
			const gaveUp = new Promise<void>((resolve) => {
				if (options.timeoutMs && options.timeoutMs > 0) timer = setTimeout(resolve, options.timeoutMs);
				if (options.signal) {
					onAbort = () => resolve();
					if (options.signal.aborted) resolve();
					else options.signal.addEventListener("abort", onAbort, { once: true });
				}
			});
			await Promise.race([Promise.all(pending), gaveUp]);
			if (timer) clearTimeout(timer);
			if (onAbort) options.signal?.removeEventListener("abort", onAbort);
		}
		return refs.map((ref) => {
			const rt = this.runtimes.get(keyOf(ref));
			const record = rt?.record ?? this.store.load(ref.cwd, ref.id);
			if (!record) return { ref, running: false };
			const running = !!rt?.active;
			const finished = [...record.assignments].reverse().find((assignment) => assignment.outcome);
			return { ref, record, running, result: finished && !running ? this.resultFromRecord(record, finished) : undefined };
		});
	}

	/** Rebuild a result from the registry, for reports collected after the fact. */
	resultFromRecord(record: SubagentRecord, assignment: AssignmentRecord): AssignmentResult {
		let report = "";
		if (assignment.reportFile) {
			try {
				report = readFileSync(assignment.reportFile, "utf8").trimEnd();
			} catch {
				report = "";
			}
		}
		return {
			id: record.id,
			title: record.title,
			n: assignment.n,
			outcome: assignment.outcome ?? "failed",
			error: assignment.error,
			limitHit: assignment.limitHit,
			report,
			reportFile: assignment.reportFile,
			sessionFile: record.sessionFile,
			model: assignment.model,
			turns: assignment.turns,
			durationMs: (assignment.endedAt ?? Date.now()) - assignment.startedAt,
			usage: assignment.usage,
		};
	}

	/**
	 * Mark a report as delivered to a requester. Returns true only for the first
	 * caller, which is the one that should account for the assignment's usage.
	 */
	claim(ref: SubagentRef, n: number): boolean {
		return this.flag(ref, n, "collected");
	}

	/** Mark that a completion notice reached the requester's model. Returns true the first time. */
	noticed(ref: SubagentRef, n: number): boolean {
		return this.flag(ref, n, "noticed");
	}

	private flag(ref: SubagentRef, n: number, key: "collected" | "noticed"): boolean {
		const rt = this.runtimes.get(keyOf(ref));
		const record = rt?.record ?? this.store.load(ref.cwd, ref.id);
		const assignment = record?.assignments.find((candidate) => candidate.n === n);
		if (!record || !assignment || assignment[key]) return false;
		assignment[key] = true;
		try {
			this.store.save(record);
		} catch {
			// Best effort: the flag still holds for this process.
		}
		this.emit("change");
		return true;
	}

	// ---- views ----------------------------------------------------------

	snapshot(ref: SubagentRef): Snapshot | undefined {
		const rt = this.runtimes.get(keyOf(ref));
		const record = rt?.record ?? this.store.load(ref.cwd, ref.id);
		return record ? this.toSnapshot(record, rt) : undefined;
	}

	list(cwd: string): Snapshot[] {
		return this.store.list(cwd).map((stored) => {
			const rt = this.runtimes.get(keyOf({ cwd, id: stored.id }));
			return this.toSnapshot(rt?.record ?? stored, rt);
		});
	}

	/**
	 * Subagents this process is running, plus background reports that finished in
	 * the last few minutes and were not collected. In-memory only, so it is cheap
	 * enough for a widget that refreshes every second.
	 */
	live(cwd: string): Snapshot[] {
		const recent = Date.now() - 10 * 60_000;
		const out: Snapshot[] = [];
		for (const rt of this.runtimes.values()) {
			if (rt.ref.cwd !== cwd) continue;
			const last = rt.record.assignments[rt.record.assignments.length - 1];
			const waiting = !!last?.background && !!last.outcome && !last.collected && (last.endedAt ?? 0) > recent;
			if (rt.active || waiting) out.push(this.toSnapshot(rt.record, rt));
		}
		return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
	}

	private toSnapshot(record: SubagentRecord, rt: Runtime | undefined): Snapshot {
		const active = rt?.active;
		const assignment = active?.rec ?? record.assignments[record.assignments.length - 1];
		return {
			id: record.id,
			title: record.title,
			cwd: record.cwd,
			state: rt?.state ?? "idle",
			sessionFile: record.sessionFile,
			model: record.model,
			pid: rt?.proc?.alive ? rt.proc.pid : undefined,
			assignments: record.assignments.length,
			assignment,
			elapsedMs: active ? Date.now() - active.rec.startedAt : undefined,
			costSoFar: active?.cost,
			lastActivity: active ? rt?.lastActivity : undefined,
			activity: rt?.activity ?? [],
			updatedAt: record.updatedAt,
		};
	}

	// ---- lifecycle ------------------------------------------------------

	private armIdle(rt: Runtime): void {
		this.clearIdle(rt);
		if (!rt.proc?.alive) return;
		rt.idleTimer = setTimeout(
			() => {
				if (!rt.active) void rt.proc?.shutdown();
			},
			Math.max(0, this.settings.idleMinutes) * 60_000,
		);
		rt.idleTimer.unref?.();
	}

	private clearIdle(rt: Runtime): void {
		if (rt.idleTimer) clearTimeout(rt.idleTimer);
		rt.idleTimer = undefined;
	}

	/** Stop any assignment and end the process, leaving the session file free for another writer. */
	async release(ref: SubagentRef): Promise<void> {
		const rt = this.runtimes.get(keyOf(ref));
		if (!rt) return;
		await this.stop(ref);
		this.clearIdle(rt);
		await rt.proc?.shutdown();
	}

	/** Drop a subagent from the registry. Its session file stays where it is. */
	async forget(ref: SubagentRef): Promise<void> {
		await this.release(ref);
		this.runtimes.delete(keyOf(ref));
		this.store.remove(ref.cwd, ref.id);
		this.emit("change");
	}

	/** Stop everything. Used when pi quits: nothing keeps spending afterwards. */
	async shutdownAll(graceMs = 5000): Promise<void> {
		const work: Promise<unknown>[] = [];
		for (const rt of this.runtimes.values()) {
			this.clearIdle(rt);
			if (rt.active && !rt.active.stop) rt.active.stop = "stop";
			if (rt.state === "queued") for (const waiter of this.slotWaiters.splice(0)) waiter();
			if (rt.proc?.alive) work.push(rt.proc.shutdown(graceMs));
			if (rt.active) work.push(rt.active.done.catch(() => undefined));
		}
		await Promise.all(work);
	}

	/** Synchronous last resort for process exit handlers. */
	killAllSync(): void {
		for (const rt of this.runtimes.values()) {
			rt.proc?.killSync();
			try {
				this.store.releaseLock(rt.ref.cwd, rt.ref.id);
			} catch {
				// Exiting anyway.
			}
		}
	}
}
