/** What the requester's model sees for a finished assignment. */
import { resultHeadline } from "./format.ts";
import type { AssignmentResult } from "./types.ts";

export interface CappedText {
	text: string;
	truncated: boolean;
}

/**
 * Keep the start and the end of an over-long report. Reports lead with the
 * answer and end with open questions, so the middle is the least costly loss.
 */
export function capReport(report: string, maxChars: number, fullPath?: string): CappedText {
	if (maxChars <= 0 || report.length <= maxChars) return { text: report, truncated: false };
	const head = Math.floor(maxChars * 0.7);
	const tail = maxChars - head;
	const omitted = report.length - maxChars;
	const where = fullPath ? `; full report: ${fullPath}` : "";
	return {
		text: `${report.slice(0, head)}\n\n[… ${omitted} characters omitted${where} …]\n\n${report.slice(-tail)}`,
		truncated: true,
	};
}

/** Text returned to the model for one finished assignment. */
export function renderResult(result: AssignmentResult, maxChars: number): CappedText {
	const capped = capReport(result.report.trim(), maxChars, result.reportFile);
	const lines = [`Subagent ${resultHeadline(result)}`, `Session: ${result.sessionFile}`];
	if (result.reportFile && capped.truncated) lines.push(`Full report: ${result.reportFile}`);
	if (result.error) lines.push(`Error: ${result.error}`);
	if (result.outcome === "limit") {
		lines.push(
			`The subagent ran out of budget (${result.limitHit ?? "limit"}). Its findings so far are in its session; ` +
				"give it a follow-up assignment to continue or to write up what it has.",
		);
	} else if (result.outcome === "stopped") {
		lines.push("The assignment was stopped before it finished. The subagent keeps what it learned and can be re-engaged.");
	}
	lines.push("", capped.text || "(The subagent produced no report text.)");
	return { text: lines.join("\n"), truncated: capped.truncated };
}
