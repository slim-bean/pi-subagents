import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHandoff, ENV_KEY_DIR } from "../src/handoff.ts";

const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pi-subagent-key");

/** Run the helper the way pi runs a key command: through `sh -c`, stdin ignored. */
function keyCommand(provider: string, keyDir: string | undefined, fallback = "echo from-command"): string {
	const env = { PATH: process.env.PATH, ...(keyDir ? { [ENV_KEY_DIR]: keyDir } : {}) };
	return execFileSync("/bin/sh", ["-c", `${helper} ${provider} -- ${fallback}`], {
		env,
		encoding: "utf8",
		timeout: 5000,
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
}

function temp(): string {
	return mkdtempSync(join(tmpdir(), "pi-subagents-handoff-"));
}

test("a handed-over key is read once; afterwards the real command runs", () => {
	const base = temp();
	const handoff = createHandoff({ openai: "sk-forwarded", "anthropic-apikey": "ak-forwarded" }, base)!;
	try {
		assert.equal(statSync(handoff.dir).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(handoff.dir).sort(), ["anthropic-apikey", "openai"]);
		assert.ok(statSync(join(handoff.dir, "openai")).isFIFO(), "a pipe, not a file holding the key");
		assert.equal(statSync(join(handoff.dir, "openai")).mode & 0o777, 0o600);
		assert.equal(keyCommand("openai", handoff.dir), "sk-forwarded");
		assert.equal(keyCommand("anthropic-apikey", handoff.dir), "ak-forwarded");
		// A provider that was not handed over uses its own command.
		assert.equal(keyCommand("other", handoff.dir), "from-command");
		handoff.dispose();
		assert.ok(!existsSync(handoff.dir));
		assert.equal(keyCommand("openai", handoff.dir), "from-command", "after startup the pipe is gone");
		handoff.dispose(); // Idempotent.
	} finally {
		handoff.dispose();
		rmSync(base, { recursive: true, force: true });
	}
});

test("disposing unread pipes does not block or leave files", () => {
	const base = temp();
	try {
		const handoff = createHandoff({ openai: "sk-unread" }, base)!;
		handoff.dispose();
		assert.deepEqual(readdirSync(base), []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("outside a subagent the helper just runs the command, and passes its failure through", () => {
	assert.equal(keyCommand("openai", undefined), "from-command");
	assert.equal(keyCommand("openai", "/nonexistent/dir"), "from-command");
	assert.equal(keyCommand("openai", undefined, `printf '%s' "two words"`), "two words");
	assert.throws(() => keyCommand("openai", undefined, "false"));
	assert.throws(() => execFileSync(helper, ["openai"], { stdio: "ignore" }), "no command to fall back to");
});

test("the helper only reads pipes, and only for plain provider names", () => {
	const base = temp();
	try {
		// A regular file where a pipe is expected is ignored.
		writeFileSync(join(base, "openai"), "planted\n");
		assert.equal(keyCommand("openai", base), "from-command");
		assert.equal(keyCommand("../openai", join(base, "sub")), "from-command");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("nothing to hand over, or unusable keys, creates nothing", () => {
	const base = temp();
	try {
		assert.equal(createHandoff({}, base), undefined);
		assert.equal(createHandoff({ openai: "" }, base), undefined);
		assert.equal(createHandoff({ "../evil": "k", "a/b": "k" }, base), undefined);
		assert.equal(createHandoff({ openai: "line1\nline2" }, base), undefined);
		assert.deepEqual(readdirSync(base), []);
		assert.equal(createHandoff({ openai: "k" }, join(base, "missing", "dir")), undefined, "failure is not fatal");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
