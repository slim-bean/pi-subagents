import assert from "node:assert/strict";
import { test } from "node:test";
import { type Tool, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTools } from "../src/tools.ts";

// Exercise the registered TypeBox schemas through the real host validator,
// including StringEnum from pi-ai (a different schema builder). No supervisor,
// session directory, credentials or child process is needed to register tools.
function registeredTools(): Map<string, Tool> {
	const tools = new Map<string, Tool>();
	registerTools(
		{
			registerTool(tool) {
				tools.set(tool.name, tool);
			},
		} as ExtensionAPI,
		{
			supervisor() {
				throw new Error("schema inspection must not start a supervisor");
			},
			settings() {
				throw new Error("schema inspection must not read settings");
			},
		},
	);
	return tools;
}

function validate(tool: Tool, args: ToolCall["arguments"]): Record<string, unknown> {
	return validateToolArguments(tool, { type: "toolCall", id: "fixture", name: tool.name, arguments: args });
}

test("registered tool schemas retain optional fields and host enum/coercion semantics", () => {
	const tools = registeredTools();
	assert.deepEqual([...tools.keys()], ["subagent_run", "subagent_steer", "subagent_wait", "subagent_list", "subagent_stop"]);
	const run = tools.get("subagent_run")!;
	assert.deepEqual(validate(run, { task: "read the fixture" }), { task: "read the fixture" });
	const raw = { task: "read the fixture", thinking: "low", maxTurns: "3", background: "true" };
	const converted = validate(run, raw);
	assert.deepEqual(converted, { task: "read the fixture", thinking: "low", maxTurns: 3, background: true });
	assert.deepEqual(raw, { task: "read the fixture", thinking: "low", maxTurns: "3", background: "true" });
	converted.task = "changed by caller";
	assert.equal(validate(run, raw).task, "read the fixture", "cached validator must not retain an earlier result");
	assert.throws(() => validate(run, {}), /task/);
	assert.throws(() => validate(run, { task: "read the fixture", thinking: "not-a-level" }), /thinking/);
	assert.throws(() => validate(run, { task: "read the fixture", maxTurns: "not-a-number" }), /maxTurns/);
	assert.deepEqual(validate(tools.get("subagent_wait")!, {}), {});
	assert.deepEqual(validate(tools.get("subagent_wait")!, { ids: "s1", timeoutSeconds: "2" }), { ids: ["s1"], timeoutSeconds: 2 });
	assert.deepEqual(validate(tools.get("subagent_list")!, {}), {});
	assert.throws(() => validate(tools.get("subagent_stop")!, {}), /id/);
	assert.throws(() => validate(tools.get("subagent_steer")!, { id: "s1" }), /message/);
});
