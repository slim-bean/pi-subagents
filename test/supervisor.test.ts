import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import { type Launcher, type Seeder, type StartRequest, Supervisor } from "../src/supervisor.ts";
import { DEFAULT_SETTINGS, type Limits, type Settings, type SubagentRef } from "../src/types.ts";

const fakePi = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const NO_LIMITS: Limits = { maxTurns: 0, maxMinutes: 0, maxCostUsd: 0 };

interface Rig {
	root: string;
	store: Store;
	supervisor: Supervisor;
	logs(): Array<Record<string, any>>;
	create(title?: string, model?: string): SubagentRef;
	start(ref: SubagentRef, task: string, options?: Partial<StartRequest>): ReturnType<Supervisor["start"]>;
}

async function rig(settings: Partial<Settings>, run: (rig: Rig) => Promise<void>, env: NodeJS.ProcessEnv = {}): Promise<void> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-unit-")));
	const store = new Store(join(root, "registry"));
	const logFile = join(root, "fake.log");
	writeFileSync(logFile, "");
	const launcher: Launcher = ({ record }) => ({
		command: process.execPath,
		args: [
			fakePi,
			"--session",
			record.sessionFile,
			...(record.model ? ["--model", record.model] : []),
			...(record.thinking ? ["--thinking", record.thinking] : []),
		],
		cwd: root,
		env: { ...process.env, FAKE_LOG: logFile, PI_SUBAGENT_ID: record.id, ...env },
	});
	const seeder: Seeder = ({ id }) => {
		const sessionFile = join(root, `${id}.jsonl`);
		writeFileSync(sessionFile, "{}\n");
		return { sessionFile, sessionId: `session-${id}` };
	};
	const supervisor = new Supervisor(store, launcher, seeder);
	supervisor.configure({ ...DEFAULT_SETTINGS, ...settings });
	try {
		await run({
			root,
			store,
			supervisor,
			logs: () =>
				readFileSync(logFile, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
			create: (title = "probe", model) => {
				const record = supervisor.create({ cwd: root, title, requester: { sessionId: "requester" }, model });
				return { cwd: record.cwd, id: record.id };
			},
			start: (ref, task, options = {}) =>
				supervisor.start(ref, {
					task,
					message: task,
					requester: { sessionId: "requester" },
					background: false,
					limits: NO_LIMITS,
					trusted: false,
					...options,
				}),
		});
	} finally {
		await supervisor.shutdownAll(500);
		rmSync(root, { recursive: true, force: true });
	}
}

test("runs an assignment and records the result", async () => {
	await rig({}, async ({ supervisor, store, create, start, root }) => {
		const ref = create("alpha");
		assert.equal(ref.id, "s1");
		const result = await start(ref, "turns:2 look around").done;
		assert.equal(result.outcome, "completed");
		assert.equal(result.report, "REPORT 1 for: turns:2 look around");
		assert.equal(result.turns, 3);
		assert.equal(result.usage.totalTokens, 330);
		assert.ok(Math.abs(result.usage.cost - 0.03) < 1e-9);
		assert.equal(result.model, "fake/default");
		assert.equal(readFileSync(result.reportFile!, "utf8").trim(), result.report);
		const saved = store.load(root, "s1")!;
		assert.equal(saved.assignments.length, 1);
		assert.equal(saved.assignments[0]!.outcome, "completed");
		assert.equal(saved.assignments[0]!.collected, false);
		assert.equal(supervisor.snapshot(ref)!.state, "idle");
		// The first claim wins; that caller accounts for the usage.
		assert.equal(supervisor.claim(ref, 1), true);
		assert.equal(supervisor.claim(ref, 1), false);
		assert.equal(store.load(root, "s1")!.assignments[0]!.collected, true);
	});
});

test("a follow-up reuses the warm process; an idle process exits and is restarted on the same session", async () => {
	await rig({ idleMinutes: 0.002 }, async ({ supervisor, create, start, logs }) => {
		const ref = create();
		const first = start(ref, "first");
		await first.done;
		// Start the follow-up before the idle timer (120ms) fires.
		await start(ref, "second").done;
		assert.equal(logs().filter((l) => l.event === "spawn").length, 1);
		await sleep(400);
		assert.equal(supervisor.snapshot(ref)!.pid, undefined, "idle process exited");
		assert.ok(logs().some((l) => l.event === "stdin-closed"), "shutdown was requested by closing stdin");
		const third = await start(ref, "third").done;
		assert.equal(third.outcome, "completed");
		const spawns = logs().filter((l) => l.event === "spawn");
		assert.equal(spawns.length, 2);
		assert.equal(spawns[1]!.args[spawns[1]!.args.indexOf("--session") + 1], first.record.sessionFile);
		assert.equal(spawns[1]!.subagent, "s1");
	});
});

test("near the limit the subagent is told to wrap up; it still completes", async () => {
	await rig({}, async ({ create, start, logs, supervisor }) => {
		const ref = create();
		const result = await start(ref, "turns:50 delay:10", { limits: { ...NO_LIMITS, maxTurns: 10 } }).done;
		assert.equal(result.outcome, "completed");
		assert.match(result.report, /wrapped up after: Budget notice/);
		assert.ok(result.turns <= 10, `stopped early, used ${result.turns} turns`);
		assert.equal(logs().filter((l) => l.event === "steer").length, 1, "asked exactly once");
		assert.ok(supervisor.snapshot(ref)!.activity.some((line) => line.includes("asked to wrap up")));
	});
});

test("a subagent that ignores the warning is aborted at the hard limit", async () => {
	await rig({}, async ({ create, start, store, root }) => {
		const ref = create();
		const result = await start(ref, "turns:500 delay:5 stubborn", { limits: { ...NO_LIMITS, maxTurns: 6 } }).done;
		assert.equal(result.outcome, "limit");
		assert.equal(result.limitHit, "turns");
		assert.equal(store.load(root, "s1")!.assignments[0]!.limitHit, "turns");
	});
});

test("cost limit", async () => {
	await rig({}, async ({ create, start }) => {
		const result = await start(create(), "turns:500 delay:5 stubborn", { limits: { ...NO_LIMITS, maxCostUsd: 0.05 } }).done;
		assert.equal(result.outcome, "limit");
		assert.equal(result.limitHit, "cost");
	});
});

test("stop aborts a running assignment and keeps the subagent usable", async () => {
	await rig({}, async ({ supervisor, create, start }) => {
		const ref = create();
		const started = start(ref, "turns:500 delay:10 stubborn");
		await sleep(150);
		assert.equal(supervisor.snapshot(ref)!.state, "running");
		const stopped = await supervisor.stop(ref);
		assert.equal(stopped!.outcome, "stopped");
		assert.equal((await started.done).outcome, "stopped");
		assert.equal(await supervisor.stop(ref), undefined, "nothing left to stop");
		assert.equal((await start(ref, "again").done).outcome, "completed");
	});
});

test("steer reaches a running subagent; an idle one rejects it", async () => {
	await rig({}, async ({ supervisor, create, start }) => {
		const ref = create();
		await assert.rejects(supervisor.steer(ref, "hello"), /not running/);
		const started = start(ref, "turns:500 delay:10");
		await sleep(150);
		await supervisor.steer(ref, "focus on service accounts");
		const result = await started.done;
		assert.match(result.report, /wrapped up after: focus on service accounts/);
	});
});

test("assignments beyond the concurrency cap queue, and a queued one can be stopped", async () => {
	await rig({ maxConcurrent: 1 }, async ({ supervisor, create, start, logs }) => {
		const a = create("a");
		const b = create("b");
		const c = create("c");
		const first = start(a, "turns:20 delay:10");
		const second = start(b, "quick b");
		const third = start(c, "quick c");
		await sleep(100);
		assert.equal(supervisor.snapshot(a)!.state, "running");
		assert.equal(supervisor.snapshot(b)!.state, "queued");
		assert.equal(supervisor.snapshot(c)!.state, "queued");
		assert.equal((await supervisor.stop(c))!.outcome, "stopped");
		assert.equal((await first.done).outcome, "completed");
		assert.equal((await second.done).outcome, "completed");
		assert.equal((await third.done).outcome, "stopped");
		assert.deepEqual(
			logs().filter((l) => l.event === "spawn").map((l) => l.subagent),
			["s1", "s2"],
			"the stopped one never started a process",
		);
	});
});

test("one assignment at a time per subagent", async () => {
	await rig({}, async ({ create, start }) => {
		const ref = create();
		const started = start(ref, "turns:10 delay:10");
		assert.throws(() => start(ref, "another"), /already working/);
		await started.done;
	});
});

test("a crashed process fails the assignment with its exit status", async () => {
	await rig({}, async ({ supervisor, create, start }) => {
		const ref = create();
		const result = await start(ref, "turns:5 crash").done;
		assert.equal(result.outcome, "failed");
		assert.match(result.error!, /exited \(code 3\)/);
		assert.equal(supervisor.snapshot(ref)!.pid, undefined);
		assert.equal((await start(ref, "recover").done).outcome, "completed", "restarts on demand");
	});
});

test("a model error is reported as a failure", async () => {
	await rig({}, async ({ create, start }) => {
		const result = await start(create(), "error please").done;
		assert.equal(result.outcome, "failed");
		assert.match(result.error!, /boom: provider rejected/);
	});
});

test("blocking dialogs are cancelled, and protocol noise is tolerated", async () => {
	await rig({}, async ({ supervisor, create, start, logs }) => {
		const ref = create();
		const result = await start(ref, "dialog noise turns:1").done;
		assert.equal(result.outcome, "completed");
		assert.equal(logs().find((l) => l.event === "dialog")!.answer.cancelled, true);
		const activity = supervisor.snapshot(ref)!.activity;
		assert.ok(activity.includes("cancelled dialog: Allow the risky thing?"));
		assert.ok(activity.includes("warning: heads up"));
		assert.ok(activity.includes("$ step 0"), "the record after the escape noise was still parsed");
	});
});

test("refuses to run a subagent another process owns, or one a person has open", async () => {
	await rig({}, async ({ store, root, create, start }) => {
		const ref = create();
		// A live pid that is not ours stands in for another pi process.
		writeFileSync(join(store.projectDir(root), "s1.lock"), JSON.stringify({ pid: process.ppid, kind: "child", at: Date.now() }));
		assert.throws(() => start(ref, "task"), /being run by another pi process/);
		writeFileSync(join(store.projectDir(root), "s1.lock"), JSON.stringify({ pid: process.pid, kind: "foreground", at: Date.now() }));
		assert.throws(() => start(ref, "task"), /open interactively/);
		// A dead owner's lock is stale.
		writeFileSync(join(store.projectDir(root), "s1.lock"), JSON.stringify({ pid: 2 ** 22 + 12345, kind: "child", at: Date.now() }));
		assert.equal((await start(ref, "task").done).outcome, "completed");
	});
});

test("the lock is held while the process lives and released when it exits", async () => {
	await rig({}, async ({ supervisor, store, root, create, start }) => {
		const ref = create();
		await start(ref, "task").done;
		assert.deepEqual({ ...store.readLock(root, "s1"), at: 0 }, { pid: process.pid, kind: "child", at: 0 });
		await supervisor.release(ref);
		assert.equal(store.readLock(root, "s1"), undefined);
		assert.ok(!existsSync(join(store.projectDir(root), "s1.lock")));
	});
});

test("wait returns on timeout while work continues, then returns the report", async () => {
	await rig({}, async ({ supervisor, create, start }) => {
		const ref = create();
		start(ref, "turns:30 delay:10", { background: true });
		const early = await supervisor.wait([ref], { timeoutMs: 50 });
		assert.equal(early[0]!.running, true);
		assert.equal(early[0]!.result, undefined);
		const done = await supervisor.wait([ref]);
		assert.equal(done[0]!.running, false);
		assert.match(done[0]!.result!.report, /REPORT 1/);
		// Later calls rebuild the result from the registry.
		const again = await supervisor.wait([ref, { cwd: ref.cwd, id: "s99" }]);
		assert.match(again[0]!.result!.report, /REPORT 1/);
		assert.equal(again[1]!.record, undefined);
	});
});

test("wait stops waiting when cancelled, without stopping the subagent", async () => {
	await rig({}, async ({ supervisor, create, start }) => {
		const ref = create();
		const started = start(ref, "turns:30 delay:10", { background: true });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 40);
		const entries = await supervisor.wait([ref], { signal: controller.signal });
		assert.equal(entries[0]!.running, true);
		assert.equal((await started.done).outcome, "completed");
	});
});

test("a model switch is applied to a live process and used for restarts", async () => {
	await rig({ idleMinutes: 0.002 }, async ({ supervisor, create, start, logs }) => {
		const ref = create("switcher", "fake/small");
		assert.equal((await start(ref, "one").done).model, "fake/small");
		const switched = await start(ref, "two", { model: "fake/large", thinking: "high" }).done;
		assert.equal(switched.model, "fake/large");
		assert.ok(logs().some((l) => l.event === "set_model" && l.model === "fake/large"));
		assert.ok(logs().some((l) => l.event === "set_thinking_level" && l.level === "high"));
		await sleep(400); // Let the idle process exit.
		await start(ref, "three").done;
		const respawn = logs().filter((l) => l.event === "spawn").pop()!;
		assert.equal(respawn.args[respawn.args.indexOf("--model") + 1], "fake/large");
		assert.equal(supervisor.snapshot(ref)!.model, "fake/large");
	});
});

test("end events fire after waiters could claim the report", async () => {
	await rig({}, async ({ supervisor, create, start }) => {
		const ref = create();
		const seen: boolean[] = [];
		supervisor.on("end", ({ assignment }) => seen.push(assignment.collected));
		const result = await start(ref, "task", { background: true }).done;
		supervisor.claim(ref, result.n);
		await sleep(20);
		assert.deepEqual(seen, [true]);
	});
});

test("shutdownAll stops running work and leaves no process behind", async () => {
	await rig({}, async ({ supervisor, create, start, store, root }) => {
		const ref = create();
		const started = start(ref, "turns:500 delay:10 stubborn");
		await sleep(120);
		const pid = supervisor.snapshot(ref)!.pid!;
		await supervisor.shutdownAll(500);
		assert.equal((await started.done).outcome, "stopped");
		assert.throws(() => process.kill(pid, 0), "process is gone");
		assert.equal(store.readLock(root, "s1"), undefined);
		assert.equal(supervisor.hasLiveWork(), false);
	});
});

test("a process that ignores the shutdown request is killed", async () => {
	await rig(
		{},
		async ({ supervisor, create, start }) => {
			const ref = create();
			await start(ref, "task").done;
			const pid = supervisor.snapshot(ref)!.pid!;
			const began = Date.now();
			await supervisor.shutdownAll(200);
			assert.throws(() => process.kill(pid, 0));
			assert.ok(Date.now() - began < 6000);
		},
		{ FAKE_IGNORE_EOF: "1" },
	);
});

test("forget removes the registry entry but not the session file", async () => {
	await rig({}, async ({ supervisor, create, start, store, root }) => {
		const ref = create();
		const { record } = start(ref, "task");
		await supervisor.wait([ref]);
		await supervisor.forget(ref);
		assert.equal(store.load(root, "s1"), undefined);
		assert.ok(existsSync(record.sessionFile));
		assert.equal(supervisor.list(root).length, 0);
	});
});

test("a replaced supervisor's processes end before the new one starts work", async () => {
	await rig({}, async ({ supervisor: old, create, start, store, root, logs }) => {
		const ref = create();
		await start(ref, "warm up").done;
		const oldPid = old.snapshot(ref)!.pid!;
		assert.equal(old.hasActiveWork(), false, "a warm idle process is not active work");
		assert.equal(old.hasLiveWork(), true);
		// What getSupervisor() does after a code reload.
		const launcher: Launcher = ({ record }) => ({
			command: process.execPath,
			args: [fakePi, "--session", record.sessionFile],
			cwd: root,
			env: { ...process.env, FAKE_LOG: join(root, "fake.log"), PI_SUBAGENT_ID: record.id },
		});
		const fresh = new Supervisor(store, launcher, () => {
			throw new Error("not used");
		});
		try {
			fresh.holdUntil(old.shutdownAll(1000));
			const result = await fresh.start(ref, {
				task: "after reload",
				message: "after reload",
				requester: {},
				background: false,
				limits: NO_LIMITS,
				trusted: false,
			}).done;
			assert.equal(result.outcome, "completed");
			assert.throws(() => process.kill(oldPid, 0), "the old process is gone");
			assert.notEqual(fresh.snapshot(ref)!.pid, oldPid);
			assert.equal(store.readLock(root, "s1")!.pid, process.pid, "the new process holds the lock");
			assert.equal(logs().filter((l) => l.event === "spawn").length, 2);
		} finally {
			await fresh.shutdownAll(500);
		}
	});
});
