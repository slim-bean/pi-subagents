// Stand-in for `pi --mode rpc`, for fast supervisor tests. Speaks just enough of the
// RPC protocol. The prompt text selects a scenario:
//   turns:N    N tool-calling turns before the final report (default 1 turn, no tools)
//   delay:MS   pause between turns
//   stubborn   ignore steering (keep going until aborted)
//   crash      exit mid-run            error    end with a model error
//   dialog     ask a blocking question  noise    write non-protocol output
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionFile = arg("--session");
let model = arg("--model") ?? "fake/default";
let thinking = arg("--thinking") ?? "medium";
const log = (record) => {
	if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ pid: process.pid, ...record })}\n`);
};
log({ event: "spawn", args, subagent: process.env.PI_SUBAGENT_ID });

const send = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const ok = (id, command, data) => send({ type: "response", id, command, success: true, data });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = (cost) => ({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: cost } });

const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
let cost = 0;
let run; // { aborted, steer }
let reports = 0;
const dialogs = new Map();

function assistant(text, stopReason, turnCost, extra = {}) {
	totals.input += 100;
	totals.output += 10;
	totals.total += 110;
	cost += turnCost;
	const content = text ? [{ type: "text", text }] : [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }];
	send({ type: "message_end", message: { role: "assistant", content, stopReason, usage: usage(turnCost), ...extra } });
	send({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
}

async function execute(message) {
	const state = { aborted: false, steer: undefined };
	run = state;
	const turns = Number(/turns:(\d+)/.exec(message)?.[1] ?? 0);
	const delay = Number(/delay:(\d+)/.exec(message)?.[1] ?? 5);
	send({ type: "agent_start" });
	if (message.includes("noise")) {
		process.stdout.write("plain text that is not a record\n");
		process.stdout.write("\x1b]6969;pi-status;abc\x07"); // escape noise directly before the next record
	}
	if (message.includes("dialog")) {
		const id = "dlg1";
		const answered = new Promise((resolve) => dialogs.set(id, resolve));
		send({ type: "extension_ui_request", id, method: "confirm", title: "Allow the risky thing?", message: "?" });
		const answer = await answered;
		log({ event: "dialog", answer });
	}
	send({ type: "extension_ui_request", id: "n1", method: "notify", message: "heads up", notifyType: "warning" });
	for (let turn = 0; turn < turns && !state.aborted; turn++) {
		if (state.steer && !message.includes("stubborn")) break;
		send({ type: "tool_execution_start", toolCallId: `t${turn}`, toolName: "bash", args: { command: `step ${turn}` } });
		await sleep(delay);
		if (message.includes("crash") && turn === 1) process.exit(3);
		if (state.aborted) break;
		assistant("", "toolUse", 0.01);
	}
	if (state.aborted) {
		send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
	} else if (message.includes("error")) {
		assistant("", "error", 0, { errorMessage: "boom: provider rejected the request" });
	} else {
		const text = state.steer ? `REPORT ${++reports} wrapped up after: ${state.steer}` : `REPORT ${++reports} for: ${message.split("\n")[0]}`;
		assistant(text, "stop", 0.01);
	}
	send({ type: "agent_end", messages: [], willRetry: false });
	run = undefined;
	send({ type: "agent_settled", aborted: state.aborted });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += chunk.toString("utf8");
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
});
process.stdin.on("end", () => {
	log({ event: "stdin-closed" });
	if (!process.env.FAKE_IGNORE_EOF) process.exit(0);
});
if (process.env.FAKE_IGNORE_EOF) process.on("SIGTERM", () => {}); // Only SIGKILL ends it.

function handle(command) {
	const { id, type } = command;
	switch (type) {
		case "get_state": {
			const slash = model.indexOf("/");
			return ok(id, type, { sessionFile, model: { provider: model.slice(0, slash), id: model.slice(slash + 1) }, thinkingLevel: thinking });
		}
		case "get_session_stats":
			return ok(id, type, { tokens: { ...totals }, cost });
		case "set_model":
			model = `${command.provider}/${command.modelId}`;
			log({ event: "set_model", model });
			return ok(id, type, {});
		case "set_thinking_level":
			thinking = command.level;
			log({ event: "set_thinking_level", level: thinking });
			return ok(id, type);
		case "prompt":
			if (run) return send({ type: "response", id, command: type, success: false, error: "agent is streaming" });
			ok(id, type, { disposition: "started" });
			log({ event: "prompt", message: command.message });
			void execute(command.message);
			return;
		case "steer":
			if (run) run.steer = command.message;
			log({ event: "steer", message: command.message });
			return ok(id, type, { disposition: "queued" });
		case "abort":
			if (run) run.aborted = true;
			// Like pi: answer once idle.
			return void (async () => {
				while (run) await sleep(2);
				ok(id, type);
			})();
		case "extension_ui_response":
			dialogs.get(command.id)?.(command);
			return;
		default:
			return send({ type: "response", id, command: type, success: false, error: `unknown command ${type}` });
	}
}
