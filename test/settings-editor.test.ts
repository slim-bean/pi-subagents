import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSettings, updateSettingsFile } from "../src/config.ts";
import { editSettings, type EditorUi } from "../src/settings-editor.ts";

/** Answers dialogs from a script. A select answer is matched by prefix against the options. */
function scripted(answers: Array<string | undefined>): EditorUi & { notes: string[]; menus: string[][] } {
	const notes: string[] = [];
	const menus: string[][] = [];
	return {
		notes,
		menus,
		async select(_title, options) {
			menus.push(options);
			const answer = answers.shift();
			if (answer === undefined) return undefined;
			const match = options.find((option) => option.startsWith(answer));
			assert.ok(match, `no option starting with "${answer}" in: ${options.join(" | ")}`);
			return match;
		},
		async input() {
			return answers.shift();
		},
		notify(message) {
			notes.push(message);
		},
	};
}

function dirs() {
	const root = mkdtempSync(join(tmpdir(), "pi-subagents-settings-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project", ".pi");
	mkdirSync(agentDir, { recursive: true });
	return { root, agentDir, projectDir, globalFile: join(agentDir, "subagents.json"), projectFile: join(projectDir, "subagents.json") };
}
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));

test("each pick saves at once; other keys in the file are kept", async () => {
	const d = dirs();
	try {
		writeFileSync(d.globalFile, JSON.stringify({ forwardAuth: ["openai"], limits: { maxMinutes: 30 }, futureKey: 1 }));
		const ui = scripted([
			"Default model", "anthropic/claude-haiku-5-5",
			"Thinking level", "low",
			"Turn limit", "40",
			"Cost limit", "$2.5",
			"Subagent file tools",
			"Background completions", "next",
			"Hand API keys", "openai, anthropic-apikey",
			"Done",
		]);
		const changed = await editSettings(ui, { agentDir: d.agentDir, models: ["anthropic/claude-haiku-5-5", "openai/gpt"] });
		assert.deepEqual([...changed].sort(), ["forwardAuth", "limits", "model", "notify", "readOnly", "thinking"]);
		assert.deepEqual(json(d.globalFile), {
			forwardAuth: ["openai", "anthropic-apikey"],
			limits: { maxMinutes: 30, maxTurns: 40, maxCostUsd: 2.5 },
			futureKey: 1,
			model: "anthropic/claude-haiku-5-5",
			thinking: "low",
			readOnly: false,
			notify: "next",
		});
		assert.deepEqual(ui.notes, []);
		// The menu shows current values, and the next menu reflects a change.
		assert.ok(ui.menus[0]!.includes("Default model: the requesting session's model"));
		assert.ok(ui.menus[0]!.includes("Time limit per assignment: 30 minutes"));
		assert.ok(ui.menus[2]!.includes("Default model: anthropic/claude-haiku-5-5"));
		assert.ok(!ui.menus[0]!.some((option) => option.startsWith("Saving to")), "no target switch without a trusted project");
		assert.equal(loadSettings(d.agentDir, undefined).problems.filter((p) => !p.includes("futureKey")).length, 0);
	} finally {
		rmSync(d.root, { recursive: true, force: true });
	}
});

test("unset removes a key; blank input restores the default; invalid input changes nothing", async () => {
	const d = dirs();
	try {
		writeFileSync(d.globalFile, JSON.stringify({ model: "a/b", thinking: "high", limits: { maxTurns: 10 }, maxConcurrent: 2 }));
		const ui = scripted([
			"Default model", "Unset",
			"Thinking level", "Unset",
			"Turn limit", "",
			"Subagents running at once", "0",
			"Report size cap", "abc",
			"Default model", "Enter a provider", "not-a-model",
			"Keep an idle process", undefined,
			undefined,
		]);
		const changed = await editSettings(ui, { agentDir: d.agentDir, models: [] });
		assert.deepEqual(json(d.globalFile), { maxConcurrent: 2 });
		assert.deepEqual([...changed].sort(), ["limits", "model", "thinking"]);
		assert.equal(ui.notes.length, 3);
		assert.match(ui.notes[0]!, /Not saved: "maxConcurrent" must be a number >= 1/);
		assert.match(ui.notes[1]!, /"abc" is not a whole number/);
		assert.match(ui.notes[2]!, /Not saved: "model" must look like/);
	} finally {
		rmSync(d.root, { recursive: true, force: true });
	}
});

test("the save target can be switched to the project file, which is created on first change", async () => {
	const d = dirs();
	try {
		writeFileSync(d.globalFile, JSON.stringify({ model: "a/global" }));
		const ui = scripted(["Saving to", "Default model", "a/project", "Saving to", "Done"]);
		await editSettings(ui, { agentDir: d.agentDir, projectDir: d.projectDir, models: ["a/project"] });
		assert.deepEqual(json(d.projectFile), { model: "a/project" });
		assert.deepEqual(json(d.globalFile), { model: "a/global" });
		assert.ok(ui.menus[0]!.some((option) => option.startsWith("Saving to: all projects")));
		assert.ok(ui.menus[1]!.some((option) => option.startsWith("Saving to: this project only")));
		// Back on the global target, the row says the project overrides it.
		assert.ok(ui.menus.at(-1)!.includes("Default model: a/global  (this project overrides it)"));
	} finally {
		rmSync(d.root, { recursive: true, force: true });
	}
});

test("a settings file that is not valid JSON is never overwritten", async () => {
	const d = dirs();
	try {
		writeFileSync(d.globalFile, "{ broken");
		const ui = scripted(["Subagent file tools", "Done"]);
		assert.equal((await editSettings(ui, { agentDir: d.agentDir, models: [] })).size, 0);
		assert.match(ui.notes[0]!, /Not saved: .*Fix or remove the file first/);
		assert.equal(readFileSync(d.globalFile, "utf8"), "{ broken");
		assert.match(updateSettingsFile(join(d.root, "new", "dir", "subagents.json"), ["limits", "maxTurns"], 5) ?? "ok", /ok/);
		assert.ok(existsSync(join(d.root, "new", "dir", "subagents.json")));
	} finally {
		rmSync(d.root, { recursive: true, force: true });
	}
});
