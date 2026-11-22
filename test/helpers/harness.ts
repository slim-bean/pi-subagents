/**
 * Auth-free pi harness: a fresh HOME and agent directory, an empty auth store,
 * a scripted local provider, offline. Never touches the user's real pi setup.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RpcHandlers, RpcProcess, type RpcRecord } from "../../src/rpc.ts";
import { type FakeProvider, type FakeScript, startFakeProvider } from "./fake-provider.ts";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const piCli = join(
	dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
	"bundle",
	"cli.js",
);

export interface Harness {
	/** Temporary HOME; contains the agent dir and a project dir. */
	home: string;
	agentDir: string;
	/** Working directory for pi. */
	project: string;
	provider: FakeProvider;
	env: NodeJS.ProcessEnv;
	/** Start `pi --mode rpc` in the project with the harness environment. */
	spawnPi(args?: string[], handlers?: RpcHandlers): PiClient;
	cleanup(): Promise<void>;
}

export interface PiClient {
	proc: RpcProcess;
	events: RpcRecord[];
	ui: RpcRecord[];
	request: RpcProcess["request"];
	/** Send a prompt and wait until pi has no more automatic work. */
	promptAndSettle(message: string, timeoutMs?: number): Promise<RpcRecord[]>;
	waitFor(predicate: (event: RpcRecord) => boolean, timeoutMs?: number, what?: string): Promise<RpcRecord>;
	stop(): Promise<void>;
}

export interface HarnessOptions {
	script: FakeScript;
	/** Extra settings.json keys. */
	settings?: Record<string, unknown>;
	/** Load the extension under test through settings, like an installed package. */
	withExtension?: boolean;
	/** `<agent dir>/subagents.json` content. */
	subagents?: Record<string, unknown>;
	/** auth.json content, built from the temporary HOME. Default: empty. */
	auth?: (home: string) => Record<string, unknown>;
	/** Extra extension files to load after the extension under test. */
	extensions?: string[];
}

export async function createHarness(options: HarnessOptions): Promise<Harness> {
	// realpath: macOS tmpdir is a symlink, and pi records real paths.
	const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-subagents-test-")));
	const agentDir = join(home, "agent");
	const project = join(home, "project");
	// pi's own temp directory, kept apart from the project so "inside temp" and "inside the project" differ.
	const temp = join(home, "tmp");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	mkdirSync(temp, { recursive: true });
	const provider = await startFakeProvider(options.script);
	writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify(options.auth?.(home) ?? {})}\n`, { mode: 0o600 });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					name: "fake",
					baseUrl: provider.url,
					api: "openai-completions",
					apiKey: "fake-key",
					models: ["fake-model", "fake-small"].map((id) => ({
						id,
						name: id,
						reasoning: false,
						input: ["text"],
						contextWindow: 100000,
						maxTokens: 4096,
						cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsUsageInStreaming: true,
							maxTokensField: "max_tokens",
						},
					})),
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			defaultProvider: "fake",
			defaultModel: "fake-model",
			quietStartup: true,
			...(options.withExtension ? { extensions: [join(projectRoot, "src", "index.ts"), ...(options.extensions ?? [])] } : {}),
			...options.settings,
		}),
	);
	if (options.subagents) writeFileSync(join(agentDir, "subagents.json"), JSON.stringify(options.subagents));

	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: temp,
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		PI_TELEMETRY: "0",
	};
	const clients: PiClient[] = [];

	const spawnPi = (args: string[] = [], handlers: RpcHandlers = {}): PiClient => {
		const events: RpcRecord[] = [];
		const ui: RpcRecord[] = [];
		const listeners = new Set<(event: RpcRecord) => void>();
		const proc = new RpcProcess(
			{
				command: process.execPath,
				args: [piCli, "--offline", "--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", ...args],
				cwd: project,
				env,
			},
			{
				...handlers,
				onEvent: (event) => {
					events.push(event);
					handlers.onEvent?.(event);
					for (const listener of [...listeners]) listener(event);
				},
				onUi: (request) => {
					ui.push(request);
					handlers.onUi?.(request);
				},
			},
		);
		proc.start();
		const waitFor: PiClient["waitFor"] = (predicate, timeoutMs = 30_000, what = "event") =>
			new Promise((resolvePromise, reject) => {
				const existing = events.find(predicate);
				if (existing) return resolvePromise(existing);
				const timer = setTimeout(() => {
					listeners.delete(listener);
					reject(new Error(`timed out waiting for ${what}; stderr: ${proc.stderrTail.slice(-2000)}`));
				}, timeoutMs);
				const listener = (event: RpcRecord) => {
					if (!predicate(event)) return;
					clearTimeout(timer);
					listeners.delete(listener);
					resolvePromise(event);
				};
				listeners.add(listener);
			});
		const client: PiClient = {
			proc,
			events,
			ui,
			request: proc.request.bind(proc),
			async promptAndSettle(message, timeoutMs = 60_000) {
				const from = events.length;
				let cancel = () => {};
				const settled = new Promise<void>((resolvePromise, reject) => {
					const timer = setTimeout(() => {
						listeners.delete(listener);
						reject(new Error(`prompt did not settle; stderr: ${proc.stderrTail.slice(-2000)}`));
					}, timeoutMs);
					const listener = (event: RpcRecord) => {
						if (event.type !== "agent_settled") return;
						clearTimeout(timer);
						listeners.delete(listener);
						resolvePromise();
					};
					listeners.add(listener);
					cancel = () => {
						clearTimeout(timer);
						listeners.delete(listener);
						resolvePromise();
					};
				});
				const accepted = await proc.request<RpcRecord>("prompt", { message }).catch((error) => {
					cancel();
					throw error;
				});
				// Extension commands are handled without starting a run.
				if (accepted?.disposition === "handled") cancel();
				await settled;
				return events.slice(from);
			},
			waitFor,
			stop: async () => {
				await proc.shutdown(5000);
			},
		};
		clients.push(client);
		return client;
	};

	return {
		home,
		agentDir,
		project,
		provider,
		env,
		spawnPi,
		async cleanup() {
			await Promise.all(clients.map((client) => client.stop().catch(() => {})));
			await provider.close();
			rmSync(home, { recursive: true, force: true });
		},
	};
}
