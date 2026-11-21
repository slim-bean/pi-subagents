/**
 * On-disk registry of subagents: one small JSON record per subagent, grouped by
 * project directory, plus an advisory lock naming the process that currently
 * owns the subagent's session file.
 *
 * The session JSONL is the source of truth for what a subagent did. Records
 * here only index subagents so they can be found, listed and re-engaged.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SubagentRecord } from "./types.ts";

const ID_RE = /^s[1-9][0-9]*$/;

export interface LockInfo {
	pid: number;
	/** "child": a pi process runs the subagent; "foreground": a person has its session open. */
	kind: "child" | "foreground";
	at: number;
}

/** Accepts "s3", "S3" or "3". Returns undefined for anything else. */
export function normalizeId(input: string): string | undefined {
	const value = input.trim().toLowerCase();
	const id = /^[1-9][0-9]*$/.test(value) ? `s${value}` : value;
	return ID_RE.test(id) ? id : undefined;
}

/** Same encoding pi uses for per-project session directories. */
export function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class Store {
	constructor(readonly root: string) {}

	projectDir(cwd: string): string {
		return join(this.root, encodeCwd(cwd));
	}

	recordFile(cwd: string, id: string): string {
		return join(this.projectDir(cwd), `${id}.json`);
	}

	/** Directory for a subagent's reports/ and artifacts/. */
	dir(cwd: string, id: string): string {
		return join(this.projectDir(cwd), id);
	}

	private lockFile(cwd: string, id: string): string {
		return join(this.projectDir(cwd), `${id}.lock`);
	}

	/** Reserve the next free id for this project and persist the record built for it. */
	allocate(cwd: string, build: (id: string) => SubagentRecord): SubagentRecord {
		const dir = this.projectDir(cwd);
		mkdirSync(dir, { recursive: true });
		let next = 1;
		for (const name of readdirSync(dir)) {
			const match = /^s([1-9][0-9]*)\.json$/.exec(name);
			if (match) next = Math.max(next, Number(match[1]) + 1);
		}
		for (let attempt = 0; attempt < 1000; attempt++, next++) {
			const id = `s${next}`;
			const record = build(id);
			try {
				// Exclusive create: another pi process in this project cannot take the same id.
				writeFileSync(this.recordFile(cwd, id), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
				mkdirSync(join(this.dir(cwd, id), "reports"), { recursive: true });
				mkdirSync(join(this.dir(cwd, id), "artifacts"), { recursive: true });
				return record;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		throw new Error(`Could not allocate a subagent id in ${dir}`);
	}

	load(cwd: string, id: string): SubagentRecord | undefined {
		try {
			const record = JSON.parse(readFileSync(this.recordFile(cwd, id), "utf8")) as SubagentRecord;
			return record?.version === 1 && record.id === id ? record : undefined;
		} catch {
			return undefined;
		}
	}

	save(record: SubagentRecord): void {
		const file = this.recordFile(record.cwd, record.id);
		const temp = `${file}.${process.pid}.tmp`;
		record.updatedAt = Date.now();
		writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	}

	list(cwd: string): SubagentRecord[] {
		const dir = this.projectDir(cwd);
		if (!existsSync(dir)) return [];
		const records: SubagentRecord[] = [];
		for (const name of readdirSync(dir)) {
			const match = /^(s[1-9][0-9]*)\.json$/.exec(name);
			const record = match ? this.load(cwd, match[1]!) : undefined;
			if (record) records.push(record);
		}
		return records.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
	}

	/** Remove the registry record and its reports/artifacts. The session file is left alone. */
	remove(cwd: string, id: string): void {
		rmSync(this.recordFile(cwd, id), { force: true });
		rmSync(this.lockFile(cwd, id), { force: true });
		rmSync(this.dir(cwd, id), { recursive: true, force: true });
	}

	readLock(cwd: string, id: string): LockInfo | undefined {
		try {
			const lock = JSON.parse(readFileSync(this.lockFile(cwd, id), "utf8")) as LockInfo;
			return typeof lock?.pid === "number" && pidAlive(lock.pid) ? lock : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Take the single-writer lock for a subagent's session. Advisory: pi itself
	 * does not honor it, so it only coordinates processes running this extension.
	 * Returns the live owner when another process holds it.
	 */
	acquireLock(cwd: string, id: string, kind: LockInfo["kind"]): { ok: true } | { ok: false; owner: LockInfo } {
		const file = this.lockFile(cwd, id);
		mkdirSync(this.projectDir(cwd), { recursive: true });
		const mine: LockInfo = { pid: process.pid, kind, at: Date.now() };
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				writeFileSync(file, JSON.stringify(mine), { flag: "wx", mode: 0o600 });
				return { ok: true };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const owner = this.readLock(cwd, id);
			if (owner && owner.pid !== process.pid) return { ok: false, owner };
			// Stale (dead owner, unreadable) or already ours: replace it.
			try {
				unlinkSync(file);
			} catch {
				// Raced with another process; the next attempt decides.
			}
		}
		throw new Error(`Could not take the session lock for ${id}`);
	}

	/** Release the lock if this process holds it. */
	releaseLock(cwd: string, id: string): void {
		const owner = this.readLock(cwd, id);
		if (!owner || owner.pid === process.pid) rmSync(this.lockFile(cwd, id), { force: true });
	}
}
