import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applySettings, loadSettings } from "../src/config.ts";
import { formatCost, formatDuration, formatToolCall, snapshotLine, titleFromTask } from "../src/format.ts";
import { refusal } from "../src/guard.ts";
import { makeLauncher, sessionName } from "../src/launch.ts";
import { assignmentMessage, researchInstructions } from "../src/prompt.ts";
import { capReport, renderResult } from "../src/report.ts";
import { findIdentity } from "../src/role.ts";
import { parseRecord, RpcProcess } from "../src/rpc.ts";
import { encodeCwd, normalizeId, Store } from "../src/store.ts";
import { type AssignmentResult, DEFAULT_SETTINGS, IDENTITY_ENTRY, type Identity, type SubagentRecord, ZERO_USAGE } from "../src/types.ts";

function temp(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-units-"));
}

function record(cwd: string, id: string): SubagentRecord {
	return {
		version: 1,
		id,
		title: "t",
		cwd,
		createdAt: 1,
		updatedAt: 1,
		createdBy: {},
		sessionFile: "/tmp/x.jsonl",
		sessionId: "x",
		assignments: [],
	};
}

test("parseRecord accepts records, CRLF and escape-prefixed records; rejects the rest", () => {
	assert.deepEqual(parseRecord('{"type":"agent_start"}'), { type: "agent_start" });
	assert.deepEqual(parseRecord('{"type":"a"}\r'), { type: "a" });
	assert.deepEqual(parseRecord('\x1b]6969;pi-status;abc\x07{"type":"b"}'), { type: "b" });
	assert.equal(parseRecord("plain text"), undefined);
	assert.equal(parseRecord("   "), undefined);
	assert.equal(parseRecord("[1,2]"), undefined);
	// U+2028 is legal inside a JSON string and must not split the record.
	assert.deepEqual(parseRecord('{"type":"c","t":"a\u2028b"}'), { type: "c", t: "a\u2028b" });
});

test("RpcProcess correlates responses, splits on LF only, and fails pending requests on exit", async () => {
	const script = `
		process.stdin.on("data", (d) => {
			for (const line of d.toString().split("\\n").filter(Boolean)) {
				const c = JSON.parse(line);
				const out = JSON.stringify({ type: "response", id: c.id, command: c.type, success: true, data: { text: c.text } }) + "\\n";
				if (c.type === "echo") {
					setTimeout(() => process.stdout.write(out), c.delay ?? 0);
				} else if (c.type === "split") {
					// One record delivered in two chunks, cut in the middle of a multi-byte character.
					const bytes = Buffer.from(out); const cut = bytes.indexOf(0xc3) + 1;
					process.stdout.write(bytes.subarray(0, cut)); setTimeout(() => process.stdout.write(bytes.subarray(cut)), 15);
				} else if (c.type === "fail") {
					process.stdout.write(JSON.stringify({ type: "response", id: c.id, command: "fail", success: false, error: "nope" }) + "\\n");
				} else if (c.type === "silent") {
					// Never answers.
				} else if (c.type === "die") { process.stderr.write("fatal: bad thing\\n"); process.exit(7); }
			}
		});`;
	const events: string[] = [];
	const proc = new RpcProcess(
		{ command: process.execPath, args: ["-e", script], cwd: process.cwd(), env: process.env },
		{ onExit: (exit) => events.push(`exit:${exit.code}`) },
	);
	proc.start();
	try {
		assert.equal(proc.alive, true);
		// Answers arrive out of order; each request still gets its own.
		const [slow, fast] = await Promise.all([
			proc.request("echo", { text: "one\u2028two", delay: 40 }, 5000),
			proc.request("echo", { text: "second" }, 5000),
		]);
		assert.deepEqual([slow.text, fast.text], ["one\u2028two", "second"]);
		assert.equal((await proc.request("split", { text: "ünïcödé" }, 5000)).text, "ünïcödé");
		await assert.rejects(proc.request("fail", {}, 5000), /nope/);
		await assert.rejects(proc.request("silent", {}, 50), /did not answer "silent"/);
		await assert.rejects(proc.request("die", {}, 5000), /exited \(code 7\)[\s\S]*fatal: bad thing/);
		assert.equal(proc.alive, false);
		assert.deepEqual(events, ["exit:7"]);
		await assert.rejects(proc.request("echo"), /exited \(code 7\)/);
		assert.equal((await proc.shutdown()).code, 7);
	} finally {
		proc.killSync(); // Never leave the helper process holding the test runner open.
	}
});

test("RpcProcess reports a command that cannot be started", async () => {
	const proc = new RpcProcess({ command: "/nonexistent/pi-binary", args: [], cwd: process.cwd(), env: process.env });
	proc.start();
	const exit = await proc.waitForExit();
	assert.match(exit.error ?? "", /ENOENT/);
	await assert.rejects(proc.request("get_state"), /ENOENT/);
});

test("store allocates sequential ids exclusively and round-trips records", () => {
	const root = temp();
	try {
		const store = new Store(root);
		const cwd = "/Users/someone/projects/demo";
		assert.equal(encodeCwd(cwd), "--Users-someone-projects-demo--");
		assert.equal(store.allocate(cwd, (id) => record(cwd, id)).id, "s1");
		assert.equal(store.allocate(cwd, (id) => record(cwd, id)).id, "s2");
		// A record written by another process is never reused.
		writeFileSync(join(store.projectDir(cwd), "s7.json"), JSON.stringify(record(cwd, "s7")));
		assert.equal(store.allocate(cwd, (id) => record(cwd, id)).id, "s8");
		assert.deepEqual(store.list(cwd).map((r) => r.id), ["s1", "s2", "s7", "s8"]);
		const loaded = store.load(cwd, "s2")!;
		loaded.title = "renamed";
		store.save(loaded);
		assert.equal(store.load(cwd, "s2")!.title, "renamed");
		assert.equal(store.load(cwd, "s3"), undefined);
		assert.deepEqual(store.list("/other/project"), []);
		store.remove(cwd, "s2");
		assert.equal(store.load(cwd, "s2"), undefined);
		writeFileSync(join(store.projectDir(cwd), "s9.json"), "{ not json");
		assert.equal(store.load(cwd, "s9"), undefined, "unreadable records are skipped, not fatal");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("locks: one owner, stale locks are replaced, release is owner-only", () => {
	const root = temp();
	try {
		const store = new Store(root);
		const cwd = "/p";
		assert.deepEqual(store.acquireLock(cwd, "s1", "child"), { ok: true });
		assert.deepEqual(store.acquireLock(cwd, "s1", "foreground"), { ok: true }, "re-acquire by the same process");
		assert.equal(store.readLock(cwd, "s1")!.kind, "foreground");
		const lockFile = join(store.projectDir(cwd), "s1.lock");
		writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, kind: "child", at: 1 }));
		const denied = store.acquireLock(cwd, "s1", "child");
		assert.equal(denied.ok, false);
		assert.equal(!denied.ok && denied.owner.pid, process.ppid);
		store.releaseLock(cwd, "s1");
		assert.equal(store.readLock(cwd, "s1")!.pid, process.ppid, "another owner's lock is left alone");
		writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 4242, kind: "child", at: 1 }));
		assert.equal(store.readLock(cwd, "s1"), undefined, "dead owner");
		assert.deepEqual(store.acquireLock(cwd, "s1", "child"), { ok: true });
		assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).pid, process.pid);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("normalizeId", () => {
	assert.equal(normalizeId("s3"), "s3");
	assert.equal(normalizeId(" S12 "), "s12");
	assert.equal(normalizeId("7"), "s7");
	for (const bad of ["", "s0", "0", "x3", "s3a", "../s3", "s-1"]) assert.equal(normalizeId(bad), undefined, bad);
});

test("settings: valid values apply, invalid ones are reported and ignored", () => {
	const problems: string[] = [];
	const next = applySettings(
		{
			model: "anthropic/claude-haiku",
			thinking: "low",
			maxConcurrent: 2.9,
			idleMinutes: 0,
			notify: "next",
			limits: { maxTurns: 20, maxCostUsd: 0, bogus: 1 },
			reportMaxChars: 10,
			surprise: true,
		},
		DEFAULT_SETTINGS,
		"test",
		problems,
	);
	assert.equal(next.model, "anthropic/claude-haiku");
	assert.equal(next.thinking, "low");
	assert.equal(next.maxConcurrent, 2);
	assert.equal(next.idleMinutes, 0);
	assert.equal(next.notify, "next");
	assert.deepEqual(next.limits, { maxTurns: 20, maxMinutes: DEFAULT_SETTINGS.limits.maxMinutes, maxCostUsd: 0 });
	assert.equal(next.reportMaxChars, DEFAULT_SETTINGS.reportMaxChars, "too-small cap ignored");
	assert.deepEqual(problems, [
		'test: unknown key "limits.bogus"',
		'test: "reportMaxChars" must be a number >= 1000',
		'test: unknown key "surprise"',
	]);
	assert.deepEqual(DEFAULT_SETTINGS.limits, { maxTurns: 80, maxMinutes: 45, maxCostUsd: 5 }, "defaults are not mutated");

	const auth: string[] = [];
	assert.deepEqual(applySettings({ forwardAuth: ["openai", "anthropic-apikey"] }, DEFAULT_SETTINGS, "a", auth).forwardAuth, ["openai", "anthropic-apikey"]);
	assert.deepEqual(applySettings({ forwardAuth: ["../x"] }, DEFAULT_SETTINGS, "a", auth).forwardAuth, []);
	assert.deepEqual(applySettings({ forwardAuth: true }, DEFAULT_SETTINGS, "a", auth).forwardAuth, []);
	assert.equal(auth.length, 2);

	const more: string[] = [];
	applySettings({ model: "no-slash", thinking: "ultra", notify: "loud", limits: 3 }, DEFAULT_SETTINGS, "x", more);
	assert.equal(more.length, 4);
	applySettings([1], DEFAULT_SETTINGS, "y", more);
	assert.equal(more[4], "y: expected a JSON object");
});

test("settings: project file overrides the global one; missing and broken files are handled", () => {
	const root = temp();
	try {
		const agent = join(root, "agent");
		const project = join(root, "project", ".pi");
		for (const dir of [agent, project]) rmSync(dir, { recursive: true, force: true });
		assert.deepEqual(loadSettings(agent, project), { settings: DEFAULT_SETTINGS, problems: [] });
		for (const dir of [agent, project]) writeFileSync(join(mkdir(dir), "subagents.json"), "{}");
		writeFileSync(join(agent, "subagents.json"), JSON.stringify({ model: "a/global", maxConcurrent: 2 }));
		writeFileSync(join(project, "subagents.json"), JSON.stringify({ model: "a/project" }));
		const both = loadSettings(agent, project).settings;
		assert.equal(both.model, "a/project");
		assert.equal(both.maxConcurrent, 2);
		assert.equal(loadSettings(agent, undefined).settings.model, "a/global", "untrusted project config is not read");
		writeFileSync(join(project, "subagents.json"), "{ nope");
		const broken = loadSettings(agent, project);
		assert.equal(broken.settings.model, "a/global");
		assert.equal(broken.problems.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function mkdir(dir: string): string {
	mkdirSync(dir, { recursive: true });
	return dir;
}

const sample: AssignmentResult = {
	id: "s3",
	title: "auth flow",
	n: 2,
	outcome: "completed",
	report: "Finding one.\nEvidence: src/auth.ts:10",
	reportFile: "/r/2.md",
	sessionFile: "/s/x.jsonl",
	model: "p/m",
	turns: 12,
	durationMs: 182_000,
	usage: { ...ZERO_USAGE, cost: 0.2134 },
};

test("reports are capped head-and-tail and point at the full file", () => {
	assert.deepEqual(capReport("short", 100), { text: "short", truncated: false });
	const long = `HEAD${"x".repeat(5000)}TAIL`;
	const capped = capReport(long, 1000, "/full.md");
	assert.equal(capped.truncated, true);
	assert.ok(capped.text.startsWith("HEAD") && capped.text.endsWith("TAIL"));
	assert.match(capped.text, /\[… 4008 characters omitted; full report: \/full\.md …\]/);
	assert.ok(capped.text.length < 1100);
});

test("rendered results lead with a headline and explain unfinished outcomes", () => {
	const done = renderResult(sample, 20_000).text;
	assert.match(done, /^Subagent s3 "auth flow" · completed · 12 turns · 3m02s · \$0\.21 · p\/m\nSession: \/s\/x\.jsonl\n\nFinding one\./);
	assert.ok(!done.includes("Full report:"), "no pointer when nothing was cut");
	const limit = renderResult({ ...sample, outcome: "limit", limitHit: "turns", report: "" }, 20_000).text;
	assert.match(limit, /stopped at its limit \(turns\)/);
	assert.match(limit, /ran out of budget \(turns\)/);
	assert.match(limit, /produced no report text/);
	const failed = renderResult({ ...sample, outcome: "failed", error: "boom" }, 20_000).text;
	assert.match(failed, /Error: boom/);
	assert.match(renderResult({ ...sample, report: "y".repeat(3000) }, 1000).text, /Full report: \/r\/2\.md/);
});

test("identity is found only near the top of a session, and only when well-formed", () => {
	const identity: Identity = { version: 1, id: "s2", title: "t", cwd: "/p", dir: "/d", createdAt: 1 };
	const entry = { type: "custom", customType: IDENTITY_ENTRY, data: identity };
	assert.deepEqual(findIdentity([entry]), identity);
	assert.deepEqual(findIdentity([{ type: "session_info" }, { type: "message" }, entry]), identity);
	assert.equal(findIdentity([]), undefined);
	assert.equal(findIdentity([{ type: "custom", customType: "other", data: identity }]), undefined);
	assert.equal(findIdentity([{ type: "custom", customType: IDENTITY_ENTRY, data: { version: 2, id: "s2" } }]), undefined);
	const padded = [...Array.from({ length: 60 }, () => ({ type: "message" })), entry];
	assert.equal(findIdentity(padded), undefined, "not searched deep into a long session");
});

test("prompts: instructions are stable per subagent; assignments carry the budget", () => {
	const identity: Identity = { version: 1, id: "s2", title: "auth", cwd: "/p", dir: "/reg/s2", createdAt: 1 };
	const text = researchInstructions(identity);
	assert.equal(text, researchInstructions({ ...identity, createdAt: 2 }), "no per-run data, so prompt caching holds");
	assert.match(text, /You are subagent s2 \("auth"\)/);
	assert.match(text, /\/reg\/s2\/artifacts/);
	assert.match(assignmentMessage("Do the thing", 1, { maxTurns: 10, maxMinutes: 5, maxCostUsd: 0 }), /^Assignment:\n\nDo the thing\n\nBudget: 10 turns, 5 minutes\./);
	assert.equal(assignmentMessage("  More  ", 3, { maxTurns: 0, maxMinutes: 0, maxCostUsd: 0 }), "Follow-up assignment 3:\n\nMore");
});

test("launcher: resumes the session, mirrors trust, pins the model, and marks the child", () => {
	const store = new Store("/reg");
	const launch = makeLauncher(store, () => ({ command: "/bin/node", prefix: ["/pi/cli.js"] }));
	const base = { ...record("/work", "s4"), title: "probe", sessionFile: "/sessions/a.jsonl" };
	process.env.PI_SESSION_FILE = "/stale/parent.jsonl";
	try {
		const first = launch({ record: { ...base, model: "p/m", thinking: "low" }, trusted: true });
		assert.equal(first.command, "/bin/node");
		assert.deepEqual(first.args, ["/pi/cli.js", "--mode", "rpc", "--session", "/sessions/a.jsonl", "--approve", "--model", "p/m", "--thinking", "low"]);
		assert.equal(first.cwd, "/work");
		assert.equal(first.env.PI_SUBAGENT_ID, "s4");
		assert.equal(first.env.PI_SUBAGENT_DIR, store.dir("/work", "s4"));
		assert.equal(first.env.PI_INSTANCE_LABEL, sessionName("s4", "probe"));
		assert.equal(first.env.PI_INSTANCE_TITLE, "0");
		assert.equal(first.env.PI_SESSION_FILE, undefined, "stale requester session metadata is not inherited");
		process.env.PI_SUBAGENT_KEYS = "/stale/keys";
		assert.equal(launch({ record: base, trusted: false, keyDir: "/tmp/keys-1" }).env.PI_SUBAGENT_KEYS, "/tmp/keys-1");
		assert.equal(launch({ record: base, trusted: false }).env.PI_SUBAGENT_KEYS, undefined, "no stale handoff directory is inherited");
		delete process.env.PI_SUBAGENT_KEYS;
		const untrusted = launch({ record: base, trusted: false });
		assert.deepEqual(untrusted.args, ["/pi/cli.js", "--mode", "rpc", "--session", "/sessions/a.jsonl", "--no-approve"]);
	} finally {
		delete process.env.PI_SESSION_FILE;
	}
});

test("formatting helpers", () => {
	assert.equal(formatDuration(4_400), "4s");
	assert.equal(formatDuration(182_000), "3m02s");
	assert.equal(formatDuration(3_780_000), "1h03m");
	assert.equal(formatCost(0), "$0");
	assert.equal(formatCost(0.0034), "$0.0034");
	assert.equal(formatCost(1.239), "$1.24");
	assert.equal(titleFromTask("\n  Trace how auth works across the gateway and the API servers in detail\nmore"), "Trace how auth works across the gateway and the…");
	assert.equal(formatToolCall("bash", { command: "rg -n 'foo'\n  src" }), "$ rg -n 'foo' src");
	assert.equal(formatToolCall("read", { path: "/x/y.ts" }), "read /x/y.ts");
	assert.equal(formatToolCall("grep", { pattern: "foo", path: "/x" }), "grep /foo/ /x");
	assert.equal(formatToolCall("mcp__srv__search", { query: "hello", limit: 3 }), "mcp__srv__search hello");
	assert.equal(formatToolCall("odd", undefined), "odd");
	const base = { id: "s1", title: "probe", cwd: "/p", sessionFile: "/s", assignments: 1, activity: [], updatedAt: 1 };
	const assignment = { n: 1, task: "t", requester: {}, background: true, startedAt: 1, turns: 3, usage: ZERO_USAGE, collected: false };
	assert.equal(snapshotLine({ ...base, state: "queued", assignment }), "s1 · queued · probe");
	assert.equal(
		snapshotLine({ ...base, state: "running", assignment, elapsedMs: 61_000, costSoFar: 0.5, lastActivity: "$ ls" }),
		"s1 · running · probe · turn 4 · 1m01s · $0.50 · $ ls",
	);
	assert.equal(
		snapshotLine({ ...base, state: "idle", assignment: { ...assignment, outcome: "completed", endedAt: 2 } }),
		"s1 · idle · probe · last: completed · report ready",
	);
});

test("research-only guard: file tools may write only to the subagent's directory and temp", () => {
	const identity: Identity = { version: 1, id: "s2", title: "t", cwd: "/work/project", dir: "/reg/s2", createdAt: 1 };
	const check = (tool: string, path: unknown) => refusal(tool, { path }, "/work/project", identity);
	assert.equal(check("write", "/reg/s2/artifacts/notes.md"), undefined);
	assert.equal(check("edit", "/reg/s2/artifacts/sub/x.md"), undefined);
	assert.equal(check("write", join(tmpdir(), "scratch.py")), undefined);
	assert.equal(check("write", "/tmp/scratch.py"), undefined);
	assert.match(check("write", "src/index.ts")!, /research-only: write is limited to \/reg\/s2\/artifacts/);
	assert.match(check("edit", "/work/project/README.md")!, /research-only: edit/);
	assert.match(check("write", "/reg/s2/../s3/artifacts/x")!, /research-only/, "no escaping through ..");
	assert.match(check("write", "/reg/s22/x")!, /research-only/, "prefix of a sibling directory does not count");
	assert.match(check("write", "../outside.txt")!, /research-only/);
	// A project under the system temp directory is not a scratch exemption.
	const tempProject = join(tmpdir(), "project-fixture");
	const tempIdentity = { ...identity, cwd: tempProject, dir: join(tempProject, ".registry", "s2") };
	for (const tool of ["write", "edit"]) {
		assert.match(refusal(tool, { path: "src/index.ts" }, tempProject, tempIdentity)!, /research-only/);
		assert.match(refusal(tool, { path: join(tempProject, "README.md") }, tempProject, tempIdentity)!, /research-only/);
		assert.equal(refusal(tool, { path: join(tempIdentity.dir, "artifacts", "notes.md") }, tempProject, tempIdentity), undefined);
		assert.equal(refusal(tool, { path: join(tmpdir(), "scratch.py") }, tempProject, tempIdentity), undefined);
	}
	// Other tools, and malformed calls the tool will reject itself, pass through.
	assert.equal(check("read", "/work/project/README.md"), undefined);
	assert.equal(check("bash", "anything"), undefined);
	assert.equal(check("write", undefined), undefined);
});
