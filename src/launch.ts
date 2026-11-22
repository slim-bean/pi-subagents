/** How a subagent's pi process is started. */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { RpcLaunch } from "./rpc.ts";
import type { Launcher } from "./supervisor.ts";
import { ENV_KEY_DIR } from "./handoff.ts";
import type { Store } from "./store.ts";

/** Set in every subagent process so other extensions can tell they run inside one. */
export const ENV_SUBAGENT_ID = "PI_SUBAGENT_ID";
/** The subagent's own directory (reports/, artifacts/). */
export const ENV_SUBAGENT_DIR = "PI_SUBAGENT_DIR";

/** Session-specific variables pi injects into shell tools; stale in a nested pi. */
const STALE_ENV = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"];

/**
 * Re-run the pi that is running now: same runtime, same installed version.
 * Mirrors pi's own subagent example, including Bun-compiled binaries.
 */
export function piInvocation(): { command: string; prefix: string[] } {
	const script = process.argv[1];
	const bunVirtual = !!script && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script));
	if (script && !bunVirtual && existsSync(script)) return { command: process.execPath, prefix: [script] };
	const runtime = /^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase());
	return runtime ? { command: "pi", prefix: [] } : { command: process.execPath, prefix: [] };
}

export function sessionName(id: string, title: string): string {
	return `subagent ${id}: ${title}`;
}

export function makeLauncher(store: Store, invocation: () => { command: string; prefix: string[] } = piInvocation): Launcher {
	return ({ record, trusted, keyDir }): RpcLaunch => {
		const { command, prefix } = invocation();
		const args = [...prefix, "--mode", "rpc", "--session", record.sessionFile, trusted ? "--approve" : "--no-approve"];
		if (record.model) args.push("--model", record.model);
		if (record.thinking) args.push("--thinking", record.thinking);
		const env: NodeJS.ProcessEnv = { ...process.env };
		for (const name of STALE_ENV) delete env[name];
		delete env[ENV_KEY_DIR];
		if (keyDir) env[ENV_KEY_DIR] = keyDir;
		env[ENV_SUBAGENT_ID] = record.id;
		env[ENV_SUBAGENT_DIR] = store.dir(record.cwd, record.id);
		// pi-instances: show the subagent under its own name, and never push a terminal title.
		env.PI_INSTANCE_LABEL = sessionName(record.id, record.title);
		env.PI_INSTANCE_TITLE = "0";
		return { command, args, cwd: record.cwd, env };
	};
}
