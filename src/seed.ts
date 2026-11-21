/**
 * Create a subagent's session file before its first run.
 *
 * pi only writes a session file once it holds a user or assistant message, and
 * has no flag to link a new session to a parent. Seeding the file gives every
 * subagent, from birth:
 *   - a `parentSession` header, so /resume nests it under the requester;
 *   - an identity entry, so the subagent role travels with the session file
 *     (a child process and a person opening it later both see it);
 *   - a display name.
 *
 * SessionManager produces the header, entries, ids and path; this module only
 * serializes them as JSON lines, the documented session format.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionName } from "./launch.ts";
import type { Seeder } from "./supervisor.ts";
import { IDENTITY_ENTRY, type Identity } from "./types.ts";

export const seedSession: Seeder = (request) => {
	const parent = request.requester.sessionFile;
	const manager = SessionManager.create(request.cwd, request.sessionDir, parent ? { parentSession: parent } : undefined);
	const identity: Identity = {
		version: 1,
		id: request.id,
		title: request.title,
		cwd: request.cwd,
		dir: request.dir,
		parentSessionFile: parent,
		parentSessionId: request.requester.sessionId,
		createdAt: Date.now(),
	};
	manager.appendCustomEntry(IDENTITY_ENTRY, identity);
	manager.appendSessionInfo(sessionName(request.id, request.title));
	const file = manager.getSessionFile();
	const header = manager.getHeader();
	if (!file || !header) throw new Error("pi did not provide a session file for the subagent");
	const lines = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry));
	mkdirSync(dirname(file), { recursive: true });
	// Exclusive: never overwrite an existing session.
	writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
	return { sessionFile: file, sessionId: manager.getSessionId() };
};
