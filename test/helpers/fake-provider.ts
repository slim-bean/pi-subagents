/**
 * Scripted OpenAI-compatible chat-completions server for auth-free tests.
 * Each request is handed to a script that decides the assistant turn.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
	/** Raw request body. */
	body: Record<string, any>;
	messages: Array<Record<string, any>>;
	/** All system/developer message text joined. */
	system: string;
	/** Text of the last user message. */
	lastUser: string;
	/** The last message in the request (often a tool result). */
	last: Record<string, any>;
	toolNames: string[];
}

export interface FakeTurn {
	text?: string;
	toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
	/** Delay before answering, to keep a run in flight. */
	delayMs?: number;
	/** Respond with an HTTP error instead. */
	error?: { status: number; message: string };
}

export type FakeScript = (request: FakeRequest) => FakeTurn | Promise<FakeTurn>;

export interface FakeProvider {
	url: string;
	requests: FakeRequest[];
	close(): Promise<void>;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

export async function startFakeProvider(script: FakeScript): Promise<FakeProvider> {
	const requests: FakeRequest[] = [];
	let calls = 0;
	const server: Server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
		const messages: Array<Record<string, any>> = body.messages ?? [];
		const users = messages.filter((message) => message.role === "user");
		const request: FakeRequest = {
			body,
			messages,
			system: messages
				.filter((message) => message.role === "system" || message.role === "developer")
				.map((message) => textOf(message.content))
				.join("\n"),
			lastUser: textOf(users[users.length - 1]?.content),
			last: messages[messages.length - 1] ?? {},
			toolNames: (body.tools ?? []).map((tool: any) => tool.function?.name ?? tool.name),
		};
		requests.push(request);
		const turn = await script(request);
		if (turn.delayMs) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
		if (turn.error) {
			res.writeHead(turn.error.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: turn.error.message, type: "invalid_request_error" } }));
			return;
		}
		const id = `chatcmpl-${++calls}`;
		const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model ?? "fake" };
		const send = (payload: object) => res.write(`data: ${JSON.stringify({ ...base, ...payload })}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		send({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
		if (turn.text) send({ choices: [{ index: 0, delta: { content: turn.text }, finish_reason: null }] });
		const toolCalls = turn.toolCalls ?? [];
		toolCalls.forEach((call, index) => {
			send({
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index,
									id: `call_${calls}_${index}`,
									type: "function",
									function: { name: call.name, arguments: JSON.stringify(call.arguments) },
								},
							],
						},
						finish_reason: null,
					},
				],
			});
		});
		send({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }] });
		send({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 } });
		res.write("data: [DONE]\n\n");
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
