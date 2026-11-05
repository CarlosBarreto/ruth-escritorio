// 20261104 - itera - add ruth-context extension -- Begin
/**
 * Ruth's memory for the assistant's own engine, loaded with `-e` next to the approval guard.
 *
 * Before each run started by the user it asks Ruth (`POST /v1/contexto`) for what it knows and adds
 * the answer as a hidden message. Ruth owns long-term memory, so the engine's own memory tools are
 * blocked here. Subagents do not load this file: they get no memory, and `approval-guard.ts` blocks
 * the same tools for them.
 *
 * What Ruth returns is data, not instructions; `identity.md` tells the model so. A failure never
 * stops a turn: the model is told the memory could not be reached, which must not read as "there is
 * nothing about that".
 *
 * The engine runs with its own `USERPROFILE`, so `homedir()` is not the user's folder: the config's
 * location comes from the environment, which reaches the engine unchanged.
 *
 * This file has no dependencies besides Node, so the engine loads it as is.
 */
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Names the private file holding `{ "url": "...", "token": "..." }`. */
export const CONFIG_ENV = "RUTH_CONTEXT_FILE";
/** The custom type of the hidden message. */
export const CUSTOM = "ruth-context";
/** The custom type of the session log entry: route and cost, never the memory itself. */
export const LOG_ENTRY = "ruth-context-log";
export const UNAVAILABLE = "[memoria] No pude consultar la memoria. Dilo si la pregunta depende de ella.";
export const MEMORY_TOOL_BLOCKED = "La memoria de largo plazo se consulta por Ruth.";
/** Engram's tools, bare, as `mcp__<server>__mem_*`, or as `<server>.mem_*`. */
export const MEMORY_TOOL = /(?:^|__|\.)mem_/;

const MAX_PROMPT = 4000;
const TIMEOUT_MS = 5000;

interface Config {
	url: string;
	token: string;
}

/** The endpoint's contract is not confirmed yet, so nothing here is taken for granted. */
interface Reply {
	status?: unknown;
	route?: unknown;
	tokens?: unknown;
	ms?: unknown;
	carried?: unknown;
	memory_block?: unknown;
	personas_block?: unknown;
}

interface Request {
	message: string;
	previous: string | null;
	carried: object;
}

function readConfig(): Config | null {
	try {
		// Windows PowerShell's `-Encoding utf8` starts the file with a BOM, which JSON.parse refuses.
		const text = readFileSync(process.env[CONFIG_ENV] ?? "", "utf8").replace(/^﻿/, "");
		const parsed = JSON.parse(text);
		return typeof parsed?.url === "string" && typeof parsed?.token === "string" ? parsed : null;
	} catch {
		return null;
	}
}

/** Ruth's answer, or null when there is none to use: no config, no reply, or memory reported down. */
async function consult(config: Config | null, request: Request): Promise<Reply | null> {
	if (!config) return null;
	try {
		const response = await fetch(config.url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!response.ok) return null;
		const reply: unknown = await response.json();
		if (typeof reply !== "object" || reply === null) return null;
		return (reply as Reply).status === "caida" ? null : reply;
	} catch {
		return null;
	}
}

function isRuthContext(message: { role: string; customType?: unknown }): boolean {
	return message.role === "custom" && message.customType === CUSTOM;
}

export default function ruthContext(pi: ExtensionAPI): void {
	const config = readConfig();
	let previous: string | null = null;
	let carried: object = {};

	pi.on("before_agent_start", async (event) => {
		// Only a user run has a prompt; a custom run carries a message instead.
		if (event.messageType !== "user") return undefined;
		const message = event.prompt.slice(0, MAX_PROMPT);
		const reply = await consult(config, { message, previous, carried });
		previous = message;
		try {
			pi.appendEntry(LOG_ENTRY, {
				route: reply?.route ?? "error",
				tokens: reply?.tokens ?? 0,
				ms: reply?.ms,
			});
		} catch {
			// The log is a convenience; the turn still needs its memory.
		}
		if (!reply) return { message: { customType: CUSTOM, display: false, content: UNAVAILABLE } };
		carried = typeof reply.carried === "object" && reply.carried !== null ? reply.carried : {};
		const content = [reply.personas_block, reply.memory_block]
			.filter((block) => typeof block === "string" && block !== "")
			.join("\n\n");
		// Small talk: nothing enters the conversation.
		if (!content) return undefined;
		return { message: { customType: CUSTOM, display: false, content } };
	});

	// The engine keeps these messages in the session: without this, tokens grow with every turn.
	pi.on("context", (event) => {
		const last = event.messages.findLastIndex(isRuthContext);
		return { messages: event.messages.filter((m, index) => !isRuthContext(m) || index === last) };
	});

	// Long-term memory is Ruth's, and notes are the user's to approve.
	pi.on("tool_call", (event) =>
		MEMORY_TOOL.test(event.toolName) ? { block: true, reason: MEMORY_TOOL_BLOCKED } : undefined,
	);
}
// 20261104 - itera - add ruth-context extension -- End
