/** Display helpers shared by tools, commands and the widget. Plain text only. */
import type { AssignmentRecord, AssignmentResult, Limits, Snapshot } from "./types.ts";

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCost(cost: number): string {
	if (!cost) return "$0";
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Derive a short label from a task when the caller gave no title. */
export function titleFromTask(task: string): string {
	return oneLine(task.split("\n").find((line) => line.trim()) ?? "research", 48);
}

function shortPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** One line describing a tool call, in the style of pi's built-in tool rendering. */
export function formatToolCall(name: string, args: unknown): string {
	const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
	switch (name) {
		case "bash":
			return `$ ${oneLine(text("command") ?? "", 90)}`;
		case "read":
		case "write":
		case "edit":
			return `${name} ${shortPath(text("path") ?? "")}`;
		case "grep":
			return `grep /${oneLine(text("pattern") ?? "", 40)}/ ${shortPath(text("path") ?? "")}`.trim();
		case "find":
		case "ls":
			return `${name} ${shortPath(text("path") ?? text("pattern") ?? "")}`.trim();
		case "codemode":
			return "codemode script";
		default: {
			const first = Object.values(input).find((value) => typeof value === "string") as string | undefined;
			return first ? `${name} ${oneLine(first, 70)}` : name;
		}
	}
}

export function formatLimits(limits: Limits): string {
	const parts: string[] = [];
	if (limits.maxTurns > 0) parts.push(`${limits.maxTurns} turns`);
	if (limits.maxMinutes > 0) parts.push(`${limits.maxMinutes} minutes`);
	if (limits.maxCostUsd > 0) parts.push(`$${limits.maxCostUsd}`);
	return parts.join(", ");
}

const OUTCOME_LABEL: Record<string, string> = {
	completed: "completed",
	stopped: "stopped",
	failed: "failed",
	limit: "stopped at its limit",
};

export function outcomeLabel(assignment: Pick<AssignmentRecord, "outcome" | "limitHit">): string {
	if (!assignment.outcome) return "running";
	const label = OUTCOME_LABEL[assignment.outcome] ?? assignment.outcome;
	return assignment.outcome === "limit" && assignment.limitHit ? `${label} (${assignment.limitHit})` : label;
}

/** "s3 auth flow · completed · 12 turns · 3m02s · $0.21" */
export function resultHeadline(result: AssignmentResult): string {
	const parts = [
		`${result.id} "${result.title}"`,
		outcomeLabel(result),
		`${result.turns} turn${result.turns === 1 ? "" : "s"}`,
		formatDuration(result.durationMs),
		formatCost(result.usage.cost),
	];
	if (result.model) parts.push(result.model);
	return parts.join(" · ");
}

/** Compact status line for the widget and lists. `activity: false` omits the latest tool call. */
export function snapshotLine(snapshot: Snapshot, options: { activity?: boolean } = {}): string {
	const parts = [snapshot.id, snapshot.state, oneLine(snapshot.title, 36)];
	const assignment = snapshot.assignment;
	if (snapshot.state === "running") {
		if (assignment) parts.push(`turn ${assignment.turns + 1}`);
		if (snapshot.elapsedMs !== undefined) parts.push(formatDuration(snapshot.elapsedMs));
		if (snapshot.costSoFar) parts.push(formatCost(snapshot.costSoFar));
		if (snapshot.lastActivity && options.activity !== false) parts.push(oneLine(snapshot.lastActivity, 60));
	} else if (snapshot.state !== "idle") {
		// Queued behind the concurrency cap, or its pi process is starting: nothing else to report yet.
	} else if (assignment) {
		parts.push(`last: ${outcomeLabel(assignment)}`);
		if (assignment.background && !assignment.collected) parts.push("report ready");
	}
	return parts.join(" · ");
}
