/**
 * One-shot handoff of already-resolved API keys to a starting subagent process.
 *
 * pi runs the key command of every stored credential at startup. With the
 * `bin/pi-subagent-key` wrapper in auth.json, that command first looks for a
 * named pipe `<PI_SUBAGENT_KEYS>/<provider>` and reads the key from it.
 *
 * The key is never in the child's environment, arguments, or a regular file:
 * it sits in a pipe inside a private directory, can be read once, and the
 * pipe is removed as soon as the child has started. No pi imports here.
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Environment variable naming the handoff directory. */
export const ENV_KEY_DIR = "PI_SUBAGENT_KEYS";
const PROVIDER_RE = /^[A-Za-z0-9._-]+$/;

export interface Handoff {
	dir: string;
	/** Remove the pipes. Safe to call more than once, and whether or not they were read. */
	dispose(): void;
}

/** Returns undefined when there is nothing to hand over or pipes are unavailable; the child then resolves keys itself. */
export function createHandoff(keys: Record<string, string>, base: string = tmpdir()): Handoff | undefined {
	const entries = Object.entries(keys).filter(([provider, key]) => PROVIDER_RE.test(provider) && !!key && !/[\r\n]/.test(key));
	if (entries.length === 0 || process.platform === "win32") return undefined;
	let dir: string | undefined;
	const fds: number[] = [];
	const dispose = () => {
		// Unlink first: a reader must never find a pipe whose writer is gone, or it would block.
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
		for (const fd of fds.splice(0)) {
			try {
				closeSync(fd);
			} catch {
				// Already closed.
			}
		}
	};
	try {
		dir = mkdtempSync(join(base, "pi-subagent-keys-")); // Mode 0700.
		for (const [provider, key] of entries) {
			const pipe = join(dir, provider);
			execFileSync("mkfifo", ["-m", "600", pipe], { stdio: "ignore" });
			// Read-write so the open does not wait for a reader; the key waits in the pipe buffer.
			const fd = openSync(pipe, constants.O_RDWR);
			fds.push(fd);
			writeSync(fd, `${key}\n`);
		}
		return { dir, dispose };
	} catch {
		dispose();
		return undefined;
	}
}
