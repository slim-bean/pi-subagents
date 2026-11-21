/**
 * Optional, manual: does the rest of the extension fleet behave inside a
 * subagent process? Loads the extensions named in the real pi settings (paths
 * only; no credentials, MCP servers or sessions are read) into an isolated HOME
 * with a scripted provider, then runs one assignment through a requester and a
 * child. Reports startup time, dialogs, protocol noise and stderr.
 *
 *   npm run test:fleet [-- <project dir whose .pi/settings.json to include>]
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { encodeCwd } from "../src/store.ts";
import type { FakeRequest, FakeTurn } from "./helpers/fake-provider.ts";
import { createHarness, projectRoot } from "./helpers/harness.ts";

const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const projectDir = process.argv[2] ? resolve(process.argv[2]) : undefined;

/** Only the resource lists are read from a settings file. */
function resources(settingsFile: string, base: string): { packages: string[]; extensions: string[] } {
	if (!existsSync(settingsFile)) return { packages: [], extensions: [] };
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	const local = (list: unknown): string[] =>
		(Array.isArray(list) ? list : [])
			.filter((entry): entry is string => typeof entry === "string" && !/^(npm:|git:|https?:|builtin:|-)/.test(entry))
			.map((entry) => (entry.startsWith("~/") ? join(homedir(), entry.slice(2)) : isAbsolute(entry) ? entry : resolve(base, entry)))
			.filter((path) => existsSync(path) && resolve(path) !== projectRoot);
	return { packages: local(settings.packages), extensions: local(settings.extensions) };
}

const globalResources = resources(join(realAgentDir, "settings.json"), realAgentDir);
const projectResources = projectDir ? resources(join(projectDir, ".pi", "settings.json"), join(projectDir, ".pi")) : { packages: [], extensions: [] };
const packages = [...new Set([...globalResources.packages, ...projectResources.packages])];
const extensions = [...new Set([...globalResources.extensions, ...projectResources.extensions])];
console.log(`fleet: ${packages.length} packages, ${extensions.length} extension files`);
for (const path of [...packages, ...extensions]) console.log(`  ${path.replace(homedir(), "~")}`);

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n") : "";
}

function script(request: FakeRequest): FakeTurn {
	if (request.system.includes("You are subagent")) {
		if (request.last.role === "tool") return { text: "REPORT: fleet child ran a tool and reported" };
		return { toolCalls: [{ name: "bash", arguments: { command: "echo from-child" } }] };
	}
	if (request.last.role === "tool") return { text: "done" };
	// Other extensions may append context messages after the prompt, so look back for the instruction.
	for (const message of request.messages.filter((m) => m.role === "user").slice(-4).reverse()) {
		const call = /^CALL (\w+) (\{.*\})\s*$/s.exec(contentText(message.content).trim());
		if (call) return { toolCalls: [{ name: call[1]!, arguments: JSON.parse(call[2]!) }] };
	}
	return { text: "ok" };
}

const h = await createHarness({ script, withExtension: true, extensions, settings: { packages } });
let failed = false;
try {
	const dialogs: string[] = [];
	const noise: string[] = [];
	const t0 = Date.now();
	const pi = h.spawnPi(["--approve"], {
		onDialog: (request) => dialogs.push(`${request.method}: ${request.title ?? ""}`),
		onNoise: (line) => noise.push(line),
	});
	await pi.request("get_state", {}, 120_000);
	console.log(`\nrequester ready in ${Date.now() - t0} ms`);
	const commands = (await pi.request("get_commands")).commands.map((c: any) => c.name);
	console.log(`requester commands: ${commands.length} (${commands.filter((n: string) => !n.includes(":")).slice(0, 40).join(", ")})`);

	const t1 = Date.now();
	const events = await pi.promptAndSettle('CALL subagent_run {"task":"Fleet smoke: run one tool and report","title":"fleet smoke"}', 180_000);
	const end = events.filter((e) => e.type === "tool_execution_end" && e.toolName === "subagent_run").pop();
	const out = contentText(end?.result?.content);
	console.log(`assignment round trip: ${Date.now() - t1} ms`);
	console.log(out.split("\n").slice(0, 1).join("\n"));
	if (!out.includes("REPORT: fleet child ran a tool and reported")) {
		failed = true;
		for (const request of h.provider.requests.slice(-3)) {
			console.log("request roles:", request.messages.map((m) => m.role).join(","), "| tools:", request.toolNames.length);
			console.log("last user:", JSON.stringify(request.lastUser.slice(0, 300)));
		}
		console.log("event types:", [...new Set(events.map((e) => e.type))].join(","));
		const failedMessage = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").pop();
		console.log("assistant:", JSON.stringify(failedMessage?.message).slice(0, 600));
		console.log("FAIL: no report from the child\n" + out.slice(0, 2000));
	}

	// What the child's pi process looked like from the inside.
	await pi.promptAndSettle("/subagents logs s1 100");
	const logs = pi.ui.filter((u) => u.method === "notify").map((u) => String(u.message)).filter((m) => m.startsWith("s1 ")).pop();
	console.log(`\nchild activity:\n${logs ?? "(none)"}`);
	const child = h.provider.requests.find((r) => r.system.includes("You are subagent"));
	console.log(`\nchild tools declared (${child?.toolNames.length}): ${child?.toolNames.join(", ")}`);
	console.log(`child has subagent tools: ${child?.toolNames.some((n) => n.startsWith("subagent_"))}`);
	const registry = join(h.agentDir, "subagents", encodeCwd(h.project), "s1.json");
	const record = JSON.parse(readFileSync(registry, "utf8"));
	const entries = readFileSync(record.sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	console.log(`child session entries: ${entries.map((e: any) => e.type + (e.customType ? `:${e.customType}` : e.message ? `:${e.message.role}` : "")).join(" | ")}`);

	// Idle maintenance must stay on for the requester and be off inside a subagent session.
	const maintenance = async (label: string) => {
		const from = pi.ui.length;
		await pi.promptAndSettle("/maintenance status");
		const shown = pi.ui.slice(from).filter((u) => u.method === "notify").map((u) => String(u.message)).join("\n");
		console.log(`maintenance (${label}): ${shown.split("\n").slice(0, 3).join(" / ").slice(0, 300) || "(no output; is pi-session-maintenance loaded?)"}`);
	};
	console.log("");
	await maintenance("requester session");
	await pi.promptAndSettle("/subagents enter s1");
	await pi.promptAndSettle("Fleet smoke: one more turn while entered");
	await maintenance("inside subagent s1");
	await pi.promptAndSettle("/subagents return");
	await maintenance("requester session again");

	console.log(`\nrequester dialogs: ${dialogs.length ? dialogs.join("; ") : "none"}`);
	console.log(`requester protocol noise: ${noise.length ? noise.join(" | ") : "none"}`);
	console.log(`requester warnings/errors: ${pi.ui.filter((u) => u.method === "notify" && u.notifyType !== "info").map((u) => `[${u.notifyType}] ${String(u.message).slice(0, 160)}`).join("\n  ") || "none"}`);
	const errors = pi.events.filter((e) => e.type === "extension_error");
	console.log(`requester extension errors: ${errors.length ? errors.map((e) => `${e.extensionPath}: ${e.error}`).join("\n  ") : "none"}`);
	console.log(`requester stderr tail: ${pi.proc.stderrTail.trim().slice(-600) || "(empty)"}`);
	if (noise.length > 0) failed = true;
	await pi.stop();
} catch (error) {
	failed = true;
	console.error(error);
} finally {
	await h.cleanup();
}
process.exit(failed ? 1 : 0);
