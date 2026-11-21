/**
 * Minimal client for one `pi --mode rpc` child process.
 *
 * pi ships an RpcClient, but it keeps its process handle and send method
 * private, so it cannot answer extension dialogs or control shutdown. This
 * client covers what the supervisor needs: strict LF framing, request/response
 * correlation, dialog auto-cancel, and an orderly stop.
 *
 * The child is deliberately NOT detached: it stays in the terminal's session
 * and process group, so closing the terminal reaches it (SIGHUP) and secret
 * managers that scope approval to the terminal treat it like its parent. If
 * this process dies, the child's stdin closes and pi exits on its own.
 */
import { type ChildProcess, spawn } from "node:child_process";

export interface RpcLaunch {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface RpcExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	/** Tail of the child's stderr, for diagnostics. */
	stderr: string;
}

/** Protocol records are open-ended JSON. */
export type RpcRecord = Record<string, any>;

export interface RpcHandlers {
	/** Session events: agent/turn/message/tool lifecycle and the rest of the JSON event stream. */
	onEvent?(event: RpcRecord): void;
	/** A blocking extension dialog arrived and was cancelled automatically. */
	onDialog?(request: RpcRecord): void;
	/** Fire-and-forget extension UI: notify, setStatus, setWidget, setTitle. */
	onUi?(request: RpcRecord): void;
	/** A stdout line that was not a protocol record. */
	onNoise?(line: string): void;
	onExit?(exit: RpcExit): void;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STDERR_TAIL = 8000;

interface Pending {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

/** Parse one stdout line, tolerating terminal escape noise an extension may have written before the record. */
export function parseRecord(line: string): RpcRecord | undefined {
	const text = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (!text.trim()) return undefined;
	for (const candidate of [text, text.slice(Math.max(0, text.indexOf("{")))]) {
		try {
			const value = JSON.parse(candidate);
			if (value && typeof value === "object" && !Array.isArray(value)) return value as RpcRecord;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

export class RpcProcess {
	private child?: ChildProcess;
	private chunks: Buffer[] = [];
	private pending = new Map<string, Pending>();
	private seq = 0;
	private stderr = "";
	private exit?: RpcExit;
	private exitWaiters: Array<(exit: RpcExit) => void> = [];

	constructor(
		private readonly launch: RpcLaunch,
		private readonly handlers: RpcHandlers = {},
	) {}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	get alive(): boolean {
		return !!this.child && !this.exit;
	}

	get stderrTail(): string {
		return this.stderr;
	}

	start(): void {
		if (this.child) throw new Error("RPC process already started");
		const child = spawn(this.launch.command, this.launch.args, {
			cwd: this.launch.cwd,
			env: this.launch.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk));
		child.stderr!.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL);
		});
		// A closed pipe surfaces through "exit"; without a listener the EPIPE would crash this process.
		child.stdin!.on("error", () => {});
		child.on("error", (error) => this.onExit(null, null, error.message));
		child.on("exit", (code, signal) => this.onExit(code, signal));
	}

	/** Send a command and resolve with its `data`. Rejects on failure, timeout or process exit. */
	request<T = RpcRecord>(type: string, fields: RpcRecord = {}, timeoutMs = 30_000): Promise<T> {
		if (!this.alive) return Promise.reject(new Error(this.exitMessage()));
		const id = `r${++this.seq}`;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`subagent did not answer "${type}" within ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
			this.write({ ...fields, id, type });
		});
	}

	private write(record: RpcRecord): void {
		this.child?.stdin?.write(`${JSON.stringify(record)}\n`);
	}

	private onStdout(chunk: Buffer): void {
		// Split on LF bytes only. 0x0A never occurs inside a multi-byte UTF-8
		// sequence, and JSON strings may legally contain U+2028/U+2029.
		let start = 0;
		for (let index = chunk.indexOf(0x0a); index !== -1; index = chunk.indexOf(0x0a, start)) {
			this.chunks.push(chunk.subarray(start, index));
			const line = Buffer.concat(this.chunks).toString("utf8");
			this.chunks = [];
			start = index + 1;
			this.onLine(line);
		}
		if (start < chunk.length) this.chunks.push(chunk.subarray(start));
	}

	private onLine(line: string): void {
		const record = parseRecord(line);
		if (!record) {
			if (line.trim()) this.handlers.onNoise?.(line.slice(0, 200));
			return;
		}
		if (record.type === "response") {
			const pending = typeof record.id === "string" ? this.pending.get(record.id) : undefined;
			if (!pending) return;
			this.pending.delete(record.id);
			clearTimeout(pending.timer);
			if (record.success) pending.resolve(record.data);
			else pending.reject(new Error(String(record.error ?? `${record.command} failed`)));
			return;
		}
		if (record.type === "extension_ui_request") {
			if (DIALOG_METHODS.has(record.method)) {
				// Nobody is at this terminal. Cancel so the extension continues instead of blocking forever.
				this.write({ type: "extension_ui_response", id: record.id, cancelled: true });
				this.handlers.onDialog?.(record);
			} else {
				this.handlers.onUi?.(record);
			}
			return;
		}
		this.handlers.onEvent?.(record);
	}

	private exitMessage(): string {
		const exit = this.exit;
		if (!exit) return "subagent process is not running";
		const how = exit.error ?? (exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`);
		const tail = exit.stderr.trim().split("\n").slice(-6).join("\n");
		return `subagent process exited (${how})${tail ? `:\n${tail}` : ""}`;
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null, error?: string): void {
		if (this.exit) return;
		this.exit = { code, signal, error, stderr: this.stderr };
		const failure = new Error(this.exitMessage());
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(failure);
		}
		this.pending.clear();
		for (const waiter of this.exitWaiters.splice(0)) waiter(this.exit);
		this.handlers.onExit?.(this.exit);
	}

	waitForExit(): Promise<RpcExit> {
		if (this.exit) return Promise.resolve(this.exit);
		if (!this.child) return Promise.resolve({ code: null, signal: null, error: "never started", stderr: "" });
		return new Promise((resolve) => this.exitWaiters.push(resolve));
	}

	/**
	 * Orderly stop: close stdin (pi's documented shutdown request), then SIGTERM,
	 * then SIGKILL. pi may be saving a refreshed OAuth token, so give it time.
	 */
	async shutdown(graceMs = 8000): Promise<RpcExit> {
		if (!this.child || this.exit) return this.waitForExit();
		const exited = this.waitForExit();
		const within = (ms: number) =>
			Promise.race([
				exited.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref?.()),
			]);
		this.child.stdin?.end();
		if (await within(graceMs)) return exited;
		this.child.kill("SIGTERM");
		if (await within(3000)) return exited;
		this.child.kill("SIGKILL");
		return exited;
	}

	/** Last-resort synchronous kill for process exit handlers. */
	killSync(): void {
		if (this.child && !this.exit) {
			try {
				this.child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
}
