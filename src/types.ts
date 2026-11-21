/** Shared types. No imports from pi here, so everything below is unit-testable. */

/** Custom session entry that marks a session as belonging to a subagent. */
export const IDENTITY_ENTRY = "pi-subagents:identity";
/** Custom session entry recording subagent activity in the requester's session (audit trail). */
export const EVENT_ENTRY = "pi-subagents:event";
/** Custom message type for notices sent to the requester's model. */
export const NOTICE_TYPE = "pi-subagents";

export type Outcome = "completed" | "stopped" | "failed" | "limit";
export type RunState = "idle" | "queued" | "starting" | "running";
export type NotifyMode = "interrupt" | "next" | "off";

/** 0 disables a limit. */
export interface Limits {
	maxTurns: number;
	maxMinutes: number;
	maxCostUsd: number;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export const ZERO_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };

/** The session that asked for an assignment. */
export interface Requester {
	sessionId?: string;
	sessionFile?: string;
}

export interface AssignmentRecord {
	/** 1-based position within the subagent's history. */
	n: number;
	task: string;
	requester: Requester;
	background: boolean;
	startedAt: number;
	endedAt?: number;
	outcome?: Outcome;
	error?: string;
	/** Which limit ended the assignment: "turns", "time" or "cost". */
	limitHit?: string;
	turns: number;
	usage: UsageTotals;
	model?: string;
	reportFile?: string;
	reportChars?: number;
	/** The report was returned to a requester through a tool call. */
	collected: boolean;
	/** A completion notice was delivered to the requester's model. */
	noticed?: boolean;
}

export interface SubagentRecord {
	version: 1;
	/** Project-scoped id such as "s3". */
	id: string;
	title: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	createdBy: Requester;
	sessionFile: string;
	sessionId: string;
	/** "provider/id" requested at creation or by the latest switch; undefined means pi's default. */
	model?: string;
	thinking?: string;
	assignments: AssignmentRecord[];
}

/** Written into the subagent's own session so the role travels with the session file. */
export interface Identity {
	version: 1;
	id: string;
	title: string;
	cwd: string;
	/** Directory holding this subagent's reports/ and artifacts/. */
	dir: string;
	parentSessionFile?: string;
	parentSessionId?: string;
	createdAt: number;
}

export interface SubagentRef {
	cwd: string;
	id: string;
}

export interface AssignmentResult {
	id: string;
	title: string;
	n: number;
	outcome: Outcome;
	error?: string;
	limitHit?: string;
	/** Full report text (the subagent's final message), possibly empty. */
	report: string;
	reportFile?: string;
	sessionFile: string;
	model?: string;
	turns: number;
	durationMs: number;
	usage: UsageTotals;
}

/** Live view of one subagent for lists, widgets and progress updates. */
export interface Snapshot {
	id: string;
	title: string;
	cwd: string;
	state: RunState;
	sessionFile: string;
	model?: string;
	pid?: number;
	assignments: number;
	/** Current assignment while not idle, otherwise the latest one. */
	assignment?: AssignmentRecord;
	/** Milliseconds since the current assignment started. */
	elapsedMs?: number;
	/** Cost of the current assignment so far. */
	costSoFar?: number;
	lastActivity?: string;
	activity: string[];
	updatedAt: number;
}

export interface Settings {
	/** "provider/id" for new subagents; undefined inherits the requester's model. */
	model?: string;
	thinking?: string;
	maxConcurrent: number;
	/** Minutes an idle subagent process is kept warm before it exits. */
	idleMinutes: number;
	limits: Limits;
	reportMaxChars: number;
	notify: NotifyMode;
	startTimeoutSeconds: number;
	/** Limit a subagent's write/edit tools to its own directory and the temp directory. */
	readOnly: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	maxConcurrent: 4,
	idleMinutes: 10,
	limits: { maxTurns: 80, maxMinutes: 45, maxCostUsd: 5 },
	reportMaxChars: 20000,
	notify: "interrupt",
	startTimeoutSeconds: 90,
	readOnly: true,
};
