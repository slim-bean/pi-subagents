/** Does this session belong to a subagent? The answer lives in the session file. */
import { IDENTITY_ENTRY, type Identity } from "./types.ts";

interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** The identity entry is seeded at the top of the file, so only the first entries are inspected. */
export function findIdentity(entries: Iterable<EntryLike>, scan = 40): Identity | undefined {
	let seen = 0;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === IDENTITY_ENTRY) {
			const data = entry.data as Partial<Identity> | undefined;
			if (data?.version === 1 && typeof data.id === "string" && typeof data.dir === "string" && typeof data.cwd === "string") {
				return data as Identity;
			}
		}
		if (++seen >= scan) break;
	}
	return undefined;
}
