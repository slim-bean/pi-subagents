/**
 * End-to-end test with real pi processes and no credentials.
 *
 * A requester pi (RPC mode) loads the extension from settings, exactly like an
 * installed package. Its scripted model calls the subagent tools; the
 * Supervisor starts real child pi processes that talk to the same scripted
 * provider. Run with `npm run test:pi`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeCwd } from "../src/store.ts";
import type { SubagentRecord } from "../src/types.ts";
import type { FakeRequest, FakeTurn } from "./helpers/fake-provider.ts";
import { createHarness, projectRoot } from "./helpers/harness.ts";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
}

/**
 * Requester: a user message "CALL <tool> <json>" makes the model call that tool;
 * after a tool result it answers "PARENT FINAL: <result>".
 * Subagent: recognised by its system prompt section; behaviour keyed on the task text.
 */
function script(request: FakeRequest): FakeTurn {
	const last = request.last;
	if (request.system.includes("You are subagent")) {
		const userText = request.messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
		// LOOP never stops by itself; PATIENT works until it is told the budget is nearly used.
		if (userText.includes("LOOP")) return { toolCalls: [{ name: "bash", arguments: { command: "echo looping" } }] };
		if (userText.includes("PATIENT")) {
			return userText.includes("Budget notice")
				? { text: "REPORT: wrapped up when asked" }
				: { toolCalls: [{ name: "bash", arguments: { command: "echo working" } }] };
		}
		if (userText.includes("WRITE")) {
			return last.role === "tool"
				? { text: `REPORT: write attempt said: ${contentText(last.content).slice(0, 300)}` }
				: { toolCalls: [{ name: "write", arguments: { path: "changed-by-subagent.txt", content: "oops" } }] };
		}
		if (last.role === "tool") return { text: "REPORT: tool evidence gathered" };
		if (request.lastUser.includes("SLOW")) return { delayMs: 2500, text: "REPORT: slow work done" };
		if (request.lastUser.includes("use a tool")) return { toolCalls: [{ name: "bash", arguments: { command: "echo evidence" } }] };
		const remembers = request.messages.some((m) => m.role === "assistant" && contentText(m.content).includes("REPORT: alpha"));
		if (request.lastUser.includes("Follow-up")) return { text: `REPORT: beta (remembers alpha: ${remembers})` };
		return { text: "REPORT: alpha" };
	}
	if (last.role === "tool") return { text: `PARENT FINAL: ${contentText(last.content).slice(0, 1500)}` };
	const call = /^CALL (\w+) (\{.*\})\s*$/s.exec(request.lastUser.trim());
	if (call && last.role === "user") return { toolCalls: [{ name: call[1]!, arguments: JSON.parse(call[2]!) }] };
	return { text: "ok" };
}

const h = await createHarness({
	script,
	withExtension: true,
	subagents: { idleMinutes: 5 },
	extensions: [join(projectRoot, "test", "fixtures", "maintenance-probe.ts")],
});
const probeLog = join(h.home, "maintenance-probe.log");
h.env.MAINTENANCE_PROBE_LOG = probeLog;
let failed = false;
const step = (name: string) => console.log(`ok - ${name}`);
try {
	const pi = h.spawnPi();
	const registry = join(h.agentDir, "subagents", encodeCwd(h.project));
	const record = (id: string): SubagentRecord => JSON.parse(readFileSync(join(registry, `${id}.json`), "utf8"));
	const lastToolText = (events: any[], tool: string): string => {
		const end = events.filter((e) => e.type === "tool_execution_end" && e.toolName === tool).pop();
		assert.ok(end, `no ${tool} result; events: ${[...new Set(events.map((e) => e.type))].join(",")}; stderr: ${pi.proc.stderrTail.slice(-1500)}`);
		return contentText(end.result?.content);
	};
	const sessionEntries = (file: string) =>
		readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

	// ---- startup --------------------------------------------------------
	const state = await pi.request("get_state", {}, 60_000);
	const commands = await pi.request("get_commands");
	assert.ok(commands.commands.some((c: any) => c.name === "subagents"), "/subagents is registered");
	step("extension loads in the requester");

	// ---- blocking assignment --------------------------------------------
	let events = await pi.promptAndSettle('CALL subagent_run {"task":"Investigate alpha","title":"alpha probe"}');
	let out = lastToolText(events, "subagent_run");
	assert.match(out, /Subagent s1 "alpha probe" · completed · 1 turn/);
	assert.match(out, /REPORT: alpha/);
	const parentFile = (await pi.request("get_state")).sessionFile as string;
	assert.ok(parentFile, "requester session is persisted");
	const s1 = record("s1");
	assert.equal(s1.assignments[0]!.outcome, "completed");
	assert.equal(s1.assignments[0]!.collected, true);
	assert.ok(s1.assignments[0]!.usage.cost > 0, "child cost recorded");
	assert.equal(s1.model, "fake/fake-model", "inherits the requester's model");
	const entries = sessionEntries(s1.sessionFile);
	assert.equal(entries[0].parentSession, parentFile, "child session links to the requester");
	assert.equal(entries[1].customType, "pi-subagents:identity");
	assert.ok(entries.some((e) => e.message?.role === "user" && contentText(e.message.content).includes("Investigate alpha")));
	assert.ok(entries.some((e) => e.message?.role === "assistant" && contentText(e.message.content).includes("REPORT: alpha")));
	assert.ok(existsSync(join(registry, "s1", "reports", "1.md")));
	const childRequest = h.provider.requests.find((r) => r.system.includes("You are subagent s1"));
	assert.ok(childRequest, "child received the research instructions");
	assert.ok(!childRequest.toolNames.includes("subagent_run"), "subagents cannot spawn subagents");
	assert.ok(h.provider.requests.some((r) => !r.system.includes("You are subagent") && r.toolNames.includes("subagent_run")));
	const stats = await pi.request("get_session_stats");
	assert.ok(stats.cost > 0.0012 * 2.5, `requester totals include the child's cost (got ${stats.cost})`);
	step("blocking assignment returns a report, persists a linked session, and rolls up cost");

	// ---- idle maintenance is switched off inside subagents only ------------
	const probes = readFileSync(probeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(probes, [{ subagent: "s1", operation: "configure", settings: { enabled: false } }]);
	step("subagent disables idle maintenance for its own runtime; the requester's is untouched");

	// ---- re-engagement keeps context --------------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"id":"s1","task":"Follow-up: check beta"}');
	out = lastToolText(events, "subagent_run");
	assert.match(out, /REPORT: beta \(remembers alpha: true\)/);
	assert.equal(record("s1").assignments.length, 2);
	step("follow-up continues with the earlier context");

	// ---- tool use inside the subagent -----------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"task":"Please use a tool then report","title":"tooling"}');
	out = lastToolText(events, "subagent_run");
	assert.match(out, /s2 "tooling" · completed · 2 turns/);
	assert.match(out, /REPORT: tool evidence gathered/);
	step("subagent runs its own tools");

	// ---- limits ------------------------------------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"task":"LOOP forever","title":"looper","maxTurns":3}', 90_000);
	out = lastToolText(events, "subagent_run");
	assert.match(out, /s3 "looper" · stopped at its limit \(turns\)/);
	assert.equal(record("s3").assignments[0]!.outcome, "limit");
	step("turn limit stops a runaway assignment");

	events = await pi.promptAndSettle('CALL subagent_run {"task":"PATIENT work","title":"patient","maxTurns":8}', 90_000);
	out = lastToolText(events, "subagent_run");
	assert.match(out, /s4 "patient" · completed/);
	assert.match(out, /REPORT: wrapped up when asked/);
	step("near its budget a subagent is told to wrap up, and its report comes back");

	// ---- background + notice + wait ---------------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"task":"SLOW job","title":"slow","background":true}');
	out = lastToolText(events, "subagent_run");
	assert.match(out, /Started s5 "slow" in the background/);
	const notice = await pi.waitFor(
		(e) => e.type === "message_end" && e.message?.customType === "pi-subagents" && contentText(e.message.content).includes("s5"),
		30_000,
		"background completion notice",
	);
	assert.match(contentText(notice.message.content), /Subagent s5 "slow" completed/);
	await pi.waitFor((e) => e.type === "agent_settled" && pi.events.indexOf(e) > pi.events.indexOf(notice), 30_000, "notice turn to settle");
	events = await pi.promptAndSettle('CALL subagent_wait {"ids":["s5"]}');
	out = lastToolText(events, "subagent_wait");
	assert.match(out, /REPORT: slow work done/);
	assert.equal(record("s5").assignments[0]!.collected, true);
	step("background assignment notifies the requester and its report is collected");

	// ---- stop ----------------------------------------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"id":"s5","task":"SLOW again","background":true}');
	assert.match(lastToolText(events, "subagent_run"), /Started s5/);
	events = await pi.promptAndSettle('CALL subagent_stop {"id":"s5"}');
	out = lastToolText(events, "subagent_stop");
	assert.match(out, /s5 "slow" · stopped/);
	step("stop aborts an assignment and keeps the subagent");

	// ---- list ------------------------------------------------------------------
	events = await pi.promptAndSettle("CALL subagent_list {}");
	out = lastToolText(events, "subagent_list");
	for (const id of ["s1", "s2", "s3", "s4", "s5"]) assert.ok(out.includes(`${id} · `), `list shows ${id}`);
	step("list shows every subagent");

	// ---- enter / return --------------------------------------------------------
	await pi.promptAndSettle("/subagents enter s1");
	let now = await pi.request("get_state");
	assert.equal(now.sessionFile, s1.sessionFile, "entered the subagent's real session");
	assert.equal(now.sessionName, "subagent s1: alpha probe");
	const before = h.provider.requests.length;
	await pi.promptAndSettle("Follow-up: typed by the person");
	const inside = h.provider.requests.slice(before).pop()!;
	assert.ok(inside.system.includes("You are subagent s1"), "research instructions apply when entered");
	assert.ok(!inside.toolNames.includes("subagent_run"), "no subagent tools inside a subagent session");
	await pi.promptAndSettle("/subagents return");
	now = await pi.request("get_state");
	assert.equal(now.sessionFile, parentFile, "returned to the requester session");
	const mark = h.provider.requests.length;
	await pi.promptAndSettle("anything new?");
	const afterReturn = h.provider.requests.slice(mark).pop()!;
	assert.ok(
		afterReturn.messages.some((m) => contentText(m.content).includes("worked directly in subagent s1")),
		"requester is told the subagent's context moved on",
	);
	assert.ok(afterReturn.toolNames.includes("subagent_run"), "tools are back in the requester session");
	step("enter switches into the subagent session and return comes back");

	// ---- re-engage after entering (process was released) -----------------------
	events = await pi.promptAndSettle('CALL subagent_run {"id":"s1","task":"Follow-up: after the visit"}');
	assert.match(lastToolText(events, "subagent_run"), /REPORT: beta \(remembers alpha: true\)/);
	step("subagent restarts on its session after being entered");

	// ---- research-only guard --------------------------------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"task":"WRITE into the project","title":"writer"}');
	out = lastToolText(events, "subagent_run");
	assert.match(out, /s6 "writer" · completed/);
	assert.match(out, /Subagents are research-only: write is limited to/);
	assert.ok(!existsSync(join(h.project, "changed-by-subagent.txt")), "the project file was not written");
	step("a subagent's write to a project file is refused");

	// ---- quit stops everything ---------------------------------------------------
	events = await pi.promptAndSettle('CALL subagent_run {"task":"SLOW final","title":"leftover","background":true}');
	assert.match(lastToolText(events, "subagent_run"), /Started s7/);
	// pi renames its process, so find the subagent processes by parent pid rather than by command line.
	const childPids = () =>
		execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number))
			.filter(([, ppid]) => ppid === pi.proc.pid)
			.map(([pid]) => pid!);
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const children = childPids();
	assert.ok(children.length >= 2, `expected live subagent processes before quitting, found ${children.length}`);
	await pi.stop();
	assert.deepEqual(children.filter(alive), [], "no subagent process survives the requester");
	assert.equal(record("s7").assignments[0]!.outcome, "stopped");
	assert.ok(!existsSync(join(registry, "s7.lock")), "locks are released");
	step("quitting the requester stops its subagents");

	console.log(`\nall integration checks passed (${h.provider.requests.length} model requests)`);
} catch (error) {
	failed = true;
	console.error(error);
} finally {
	await h.cleanup();
}
process.exit(failed ? 1 : 0);
