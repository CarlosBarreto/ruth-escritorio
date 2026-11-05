// 20261104 - itera - add ruth-context tests -- Begin
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APPROVAL_GUARD,
	ConnectorStore,
	engineExtensionArgs,
	RUTH_CONTEXT,
	ruthProtectedPaths,
} from "../src/connectors.ts";
import { decide } from "../src/extensions/approval-guard.ts";
import ruthContext, {
	CONFIG_ENV,
	CUSTOM,
	LOG_ENTRY,
	MEMORY_TOOL_BLOCKED,
	UNAVAILABLE,
} from "../src/extensions/ruth-context.ts";

const URL_ = "https://ruth.invalid/v1/contexto";
const TOKEN = "test-token";

type Handler = (event: unknown) => unknown;

/** The extension against a stand-in for the engine: its handlers, by event, and its log. */
function load() {
	const handlers = new Map<string, Handler>();
	const entries: { type: string; data: unknown }[] = [];
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
	};
	ruthContext(pi as unknown as ExtensionAPI);
	const run = (name: string, event: unknown) => {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`no handler for ${name}`);
		return handler(event);
	};
	return {
		entries,
		start: (prompt: string) => run("before_agent_start", { messageType: "user", prompt }),
		startCustom: () =>
			run("before_agent_start", {
				messageType: "custom",
				message: { role: "custom", customType: "other", content: "x", display: false, timestamp: 0 },
			}),
		context: (messages: unknown[]) => run("context", { type: "context", messages }),
		toolCall: (toolName: string) => run("tool_call", { toolName, input: {} }),
	};
}

const answer = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hidden = (content: string) => ({ message: { customType: CUSTOM, display: false, content } });

describe("ruth-context", () => {
	let dir: string;
	let file: string;
	const fetchMock = vi.fn<typeof fetch>();
	const sent = (call: number) => JSON.parse(fetchMock.mock.calls[call]?.[1]?.body as string);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ruth-context-"));
		file = join(dir, "contexto.json");
		writeFileSync(file, JSON.stringify({ url: URL_, token: TOKEN }));
		vi.stubEnv(CONFIG_ENV, file);
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(dir, { recursive: true, force: true });
	});

	describe("a route with blocks", () => {
		it("adds the people and memory blocks as one hidden message", async () => {
			fetchMock.mockResolvedValue(
				answer({
					route: "persona",
					status: "ok",
					personas_block: "<personas>Luis</personas>",
					memory_block: "<memoria>nota</memoria>",
					tokens: 12,
					ms: 40,
				}),
			);
			const ext = load();
			await expect(ext.start("¿Cuándo cumple Luis?")).resolves.toEqual(
				hidden("<personas>Luis</personas>\n\n<memoria>nota</memoria>"),
			);
			expect(ext.entries).toEqual([{ type: LOG_ENTRY, data: { route: "persona", tokens: 12, ms: 40 } }]);
		});

		it("posts to the configured url with the token and a time limit", async () => {
			fetchMock.mockResolvedValue(answer({ status: "ok" }));
			await load().start("hola");
			const [url, init] = fetchMock.mock.calls[0] ?? [];
			expect(url).toBe(URL_);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(sent(0)).toEqual({ message: "hola", previous: null, carried: {} });
		});

		it("sends the last prompt and what Ruth carried on the next turn", async () => {
			fetchMock.mockImplementation(async () => answer({ status: "ok", carried: { persona: "luis" } }));
			const ext = load();
			await ext.start("¿Quién es Luis?");
			await ext.start("¿y cuántos años cumple?");
			expect(sent(1)).toEqual({
				message: "¿y cuántos años cumple?",
				previous: "¿Quién es Luis?",
				carried: { persona: "luis" },
			});
		});

		it("limits the prompt it sends", async () => {
			fetchMock.mockResolvedValue(answer({ status: "ok" }));
			await load().start("x".repeat(5000));
			expect(sent(0).message).toHaveLength(4000);
		});

		it("works without the fields the contract does not confirm", async () => {
			fetchMock.mockResolvedValue(answer({ memory_block: "<memoria>nota</memoria>" }));
			const ext = load();
			await expect(ext.start("¿Qué es Laya?")).resolves.toEqual(hidden("<memoria>nota</memoria>"));
			await ext.start("otra");
			expect(sent(1).carried).toEqual({});
			expect(ext.entries[0]?.data).toEqual({ route: "error", tokens: 0, ms: undefined });
		});
	});

	it.each([
		["charla", { route: "charla", status: "ok", memory_block: "", personas_block: "", tokens: 0 }],
		["sin_contexto", { route: "general", status: "sin_contexto", memory_block: null }],
	])("adds nothing when there is no content (%s)", async (_name, body) => {
		fetchMock.mockResolvedValue(answer(body));
		await expect(load().start("Hola")).resolves.toBeUndefined();
	});

	describe("when the memory cannot be reached", () => {
		it.each<[string, () => void]>([
			["the server is down", () => fetchMock.mockRejectedValue(new TypeError("fetch failed"))],
			["it answers with an error", () => fetchMock.mockResolvedValue(answer({}, 503))],
			["it does not answer JSON", () => fetchMock.mockResolvedValue(new Response("<html>"))],
			["it answers JSON null", () => fetchMock.mockResolvedValue(answer(null))],
			["it says the memory is down", () => fetchMock.mockResolvedValue(answer({ status: "caida" }))],
			[
				"it says the memory is down and still sends blocks",
				() =>
					fetchMock.mockResolvedValue(
						answer({ route: "general", status: "caida", memory_block: "<memoria>vieja</memoria>" }),
					),
			],
		])("tells the model when %s", async (_name, arrange) => {
			arrange();
			const ext = load();
			await expect(ext.start("¿Qué es Laya?")).resolves.toEqual(hidden(UNAVAILABLE));
			expect(ext.entries).toEqual([{ type: LOG_ENTRY, data: { route: "error", tokens: 0, ms: undefined } }]);
		});

		it("keeps what Ruth carried for the next turn", async () => {
			fetchMock.mockResolvedValueOnce(answer({ status: "ok", carried: { persona: "luis" } }));
			fetchMock.mockResolvedValueOnce(answer({ status: "caida", carried: {} }));
			fetchMock.mockResolvedValueOnce(answer({ status: "ok" }));
			const ext = load();
			await ext.start("uno");
			await ext.start("dos");
			await ext.start("tres");
			expect(sent(2)).toEqual({ message: "tres", previous: "dos", carried: { persona: "luis" } });
		});

		it("does not lose the turn when the log fails", async () => {
			fetchMock.mockRejectedValue(new TypeError("fetch failed"));
			const handlers = new Map<string, Handler>();
			const pi = {
				on: (name: string, handler: Handler) => handlers.set(name, handler),
				appendEntry: () => {
					throw new Error("no session");
				},
			};
			ruthContext(pi as unknown as ExtensionAPI);
			await expect(
				handlers.get("before_agent_start")?.({ messageType: "user", prompt: "hola" }),
			).resolves.toEqual(hidden(UNAVAILABLE));
		});
	});

	describe("config", () => {
		it.each<[string, () => void]>([
			["the variable is not set", () => vi.stubEnv(CONFIG_ENV, undefined)],
			["the file is missing", () => rmSync(file)],
			["the file is not JSON", () => writeFileSync(file, "{not json")],
			["the file has no token", () => writeFileSync(file, JSON.stringify({ url: URL_ }))],
			["the file is JSON null", () => writeFileSync(file, "null")],
			[
				"the path is a folder",
				() => {
					const folder = join(dir, "folder");
					mkdirSync(folder);
					vi.stubEnv(CONFIG_ENV, folder);
				},
			],
		])("loads and reports the memory as unavailable when %s", async (_name, arrange) => {
			arrange();
			const ext = load();
			await expect(ext.start("¿Qué es Laya?")).resolves.toEqual(hidden(UNAVAILABLE));
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it("reads a file saved with a byte order mark", async () => {
			writeFileSync(file, `﻿${JSON.stringify({ url: URL_, token: TOKEN })}`);
			fetchMock.mockResolvedValue(answer({ status: "ok" }));
			await load().start("hola");
			expect(fetchMock).toHaveBeenCalledOnce();
		});
	});

	it("ignores a custom run, which has no prompt", async () => {
		const ext = load();
		await expect(ext.startCustom()).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ext.entries).toEqual([]);
	});

	describe("context", () => {
		const ours = (content: string) => ({
			role: "custom",
			customType: CUSTOM,
			content,
			display: false,
			timestamp: 0,
		});
		const user = { role: "user", content: "hola", timestamp: 0 };
		const other = { role: "custom", customType: "other", content: "x", display: false, timestamp: 0 };

		it("keeps only the last ruth-context message and everything else", () => {
			const last = ours("3");
			expect(load().context([ours("1"), user, ours("2"), other, user, last, user])).toEqual({
				messages: [user, other, user, last, user],
			});
		});

		it("leaves a conversation without one alone", () => {
			expect(load().context([user, other])).toEqual({ messages: [user, other] });
		});

		it("does not take a message of another role for one of its own", () => {
			const lookalike = { role: "user", customType: CUSTOM, content: "x", timestamp: 0 };
			expect(load().context([lookalike, ours("1")])).toEqual({ messages: [lookalike, ours("1")] });
		});
	});

	describe("memory tools", () => {
		it.each(["mem_save", "mem_search", "mcp__engram__mem_save", "engram.mem_save", "x.mem_save"])(
			"blocks %s",
			(tool) => {
				expect(load().toolCall(tool)).toEqual({ block: true, reason: MEMORY_TOOL_BLOCKED });
			},
		);

		it.each(["read", "bash", "memory_save", "remem_save", "mcp__notion__search", "mcp__x__add_mem_save"])(
			"lets %s through",
			(tool) => {
				expect(load().toolCall(tool)).toBeUndefined();
			},
		);
	});
});

describe("loading ruth-context", () => {
	it("goes into the assistant's own engine, after the approval guard", () => {
		expect(engineExtensionArgs("/data/agent")).toEqual(["-e", APPROVAL_GUARD, "-e", RUTH_CONTEXT]);
	});

	it("stays out of any other engine", () => {
		expect(engineExtensionArgs(undefined)).toEqual([]);
	});

	it("is the file the extensions folder holds", () => {
		expect(RUTH_CONTEXT.replaceAll("\\", "/")).toMatch(/\/src\/extensions\/ruth-context\.ts$/);
	});
});

describe("protecting ruth-context", () => {
	const config = join(tmpdir(), "ruth", "contexto.json");

	it("covers the extension, and the config file when it is set", () => {
		expect(ruthProtectedPaths({})).toEqual([RUTH_CONTEXT]);
		expect(ruthProtectedPaths({ RUTH_CONTEXT_FILE: "" })).toEqual([RUTH_CONTEXT]);
		expect(ruthProtectedPaths({ RUTH_CONTEXT_FILE: config })).toEqual([RUTH_CONTEXT, config]);
	});

	it("reaches the policy, and the guard blocks them", () => {
		const dir = mkdtempSync(join(tmpdir(), "ruth-policy-"));
		const agentHome = join(dir, "agent");
		mkdirSync(agentHome);
		const store = new ConnectorStore({
			dataDir: dir,
			agentHome,
			extraProtectedPaths: ruthProtectedPaths({ RUTH_CONTEXT_FILE: config }),
		});
		try {
			const policy = store.policy();
			expect(policy.protectedPaths).toEqual(expect.arrayContaining([RUTH_CONTEXT, config]));
			const call = (toolName: string, input: Record<string, unknown>) =>
				decide({ toolName, input, cwd: dir }, policy).action;
			expect(call("read", { path: config })).toBe("block");
			expect(call("edit", { path: RUTH_CONTEXT })).toBe("block");
			expect(call("bash", { command: "type contexto.json" })).toBe("block");
			expect(call("bash", { command: "echo x > ruth-context.ts" })).toBe("block");
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
// 20261104 - itera - add ruth-context tests -- End
