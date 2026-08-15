import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import deepSeekAnchor, {
	capOutputTokens,
	hasPromotionSignal,
	isDeepSeekModel,
} from "../src/index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type TestModel = { provider: string; id: string; api: string };

const deepSeek = {
	provider: "ccs-codex-deepseek",
	id: "deepseek-v4-pro",
	api: "openai-responses",
};
const claude = {
	provider: "anthropic",
	id: "claude-sonnet-5",
	api: "anthropic-messages",
};

function message(role: "user" | "assistant") {
	return { type: "message", message: { role } };
}

function harness(
	options: { model?: TestModel; branch?: unknown[]; tools?: string[] } = {},
) {
	const {
		model = deepSeek,
		branch = [],
		tools = ["bash", "read", "edit", "grep"],
	} = options;
	const handlers = new Map<string, Handler[]>();
	const toolSets: string[][] = [];
	const warnings: string[] = [];
	let activeTools = [...tools];
	// The fake only implements the context surface exercised by this extension.
	const ctx = {
		model,
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		getActiveTools() {
			return [...activeTools];
		},
		async setActiveTools(next: string[]) {
			activeTools = [...next];
			toolSets.push([...next]);
		},
		logger: {
			warn(text: string) {
				warnings.push(text);
			},
		},
	};

	deepSeekAnchor(pi as unknown as ExtensionAPI);

	return {
		ctx,
		toolSets,
		warnings,
		activeTools: () => activeTools,
		async emit(event: string, payload: unknown = { type: event }) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? [])
				result = await handler(payload, ctx);
			return result;
		},
	};
}

describe("model and session detection", () => {
	test("matches DeepSeek in either provider or model id", () => {
		expect(
			isDeepSeekModel(deepSeek as unknown as ExtensionContext["model"]),
		).toBe(true);
		expect(
			isDeepSeekModel({
				...claude,
				id: "deepseek-r1",
			} as unknown as ExtensionContext["model"]),
		).toBe(true);
		expect(
			isDeepSeekModel(claude as unknown as ExtensionContext["model"]),
		).toBe(false);
	});

	test("uses a durable assistant message as the promotion signal", () => {
		expect(
			hasPromotionSignal({
				sessionManager: { getBranch: () => [message("user")] },
			} as unknown as Pick<ExtensionContext, "sessionManager">),
		).toBe(false);
		expect(
			hasPromotionSignal({
				sessionManager: { getBranch: () => [message("assistant")] },
			} as unknown as Pick<ExtensionContext, "sessionManager">),
		).toBe(true);
	});
});

describe("two-phase tool catalog", () => {
	test("fresh DeepSeek sessions start with bash and read", async () => {
		const app = harness();
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["bash", "read"]);
	});

	test("a tool call restores the exact original catalog", async () => {
		const app = harness();
		await app.emit("session_start");
		await app.emit("tool_call", { type: "tool_call", toolName: "read" });
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);
	});

	test("a text-only first reply restores tools at agent end", async () => {
		const app = harness();
		await app.emit("before_agent_start", { type: "before_agent_start" });
		await app.emit("agent_end", { type: "agent_end", messages: [] });
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);
	});

	test("existing and non-DeepSeek sessions are unchanged", async () => {
		const existing = harness({ branch: [message("assistant")] });
		await existing.emit("session_start");
		expect(existing.toolSets).toEqual([]);

		const other = harness({ model: claude });
		await other.emit("session_start");
		expect(other.toolSets).toEqual([]);
	});

	test("missing bootstrap tools fails open", async () => {
		const app = harness({ tools: ["read", "edit"] });
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["read", "edit"]);
		expect(app.warnings).toHaveLength(1);
	});
});

describe("first-request output cap", () => {
	test("caps Responses and Chat payloads without raising a lower limit", () => {
		expect(
			capOutputTokens({ max_output_tokens: 64000 }, "openai-responses"),
		).toEqual({ max_output_tokens: 1024 });
		expect(
			capOutputTokens({ max_tokens: 64000 }, "openai-completions"),
		).toEqual({ max_tokens: 1024 });
		expect(capOutputTokens({ max_tokens: 512 }, "openai-completions")).toEqual({
			max_tokens: 512,
		});
	});

	test("the request hook stops changing payloads after promotion", async () => {
		const app = harness();
		await app.emit("session_start");
		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { max_output_tokens: 64000, tools: ["bash", "read"] },
		});
		expect(first).toEqual({ max_output_tokens: 1024, tools: ["bash", "read"] });

		await app.emit("tool_call", { type: "tool_call", toolName: "read" });
		const secondPayload = {
			max_output_tokens: 64000,
			tools: ["bash", "read", "edit"],
		};
		const second = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: secondPayload,
		});
		expect(second).toBe(secondPayload);
	});
});
