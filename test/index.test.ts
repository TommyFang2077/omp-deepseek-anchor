import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import deepSeekAnchor, {
	capOutputTokens,
	DSH_ANCHOR_TEXT,
	hasPromotionSignal,
	isDeepSeekModel,
	prependAnchor,
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
	options: {
		model?: TestModel;
		branch?: unknown[];
		tools?: string[];
		mode?: "safe" | "dsh";
	} = {},
) {
	const {
		model = deepSeek,
		branch = [],
		tools = ["bash", "read", "edit", "grep"],
		mode = "safe",
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
		getAllTools() {
			return [...activeTools].map((name) => ({
				name,
				description: name,
				parameters: {},
				sourceInfo: { path: `<test:${name}>`, source: "extension" },
			}));
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

	deepSeekAnchor(pi as unknown as ExtensionAPI, mode);

	return {
		ctx,
		toolSets,
		warnings,
		activeTools: () => activeTools,
		activateTools(...names: string[]) {
			activeTools = [...new Set([...activeTools, ...names])];
		},
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

	test("late-registered tools stay out of request one and restore later", async () => {
		const app = harness();
		await app.emit("session_start");
		app.activateTools("mcp__late");

		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				max_output_tokens: 64000,
				tools: [
					{ type: "function", name: "bash" },
					{ type: "function", name: "read" },
					{ type: "function", name: "mcp__late" },
					{ type: "function", function: { name: "edit" } },
				],
			},
		});

		expect(first).toEqual({
			max_output_tokens: 1024,
			tools: [
				{ type: "function", name: "bash" },
				{ type: "function", name: "read" },
			],
		});
		expect(app.activeTools()).toEqual(["bash", "read"]);

		await app.emit("tool_call", { type: "tool_call", toolName: "read" });
		expect(app.activeTools()).toEqual([
			"bash",
			"read",
			"edit",
			"grep",
			"mcp__late",
		]);
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

		const other = harness({ model: claude, mode: "dsh" });
		await other.emit("session_start");
		expect(other.toolSets).toEqual([]);
		const payload = { instructions: "full prompt", tools: ["bash", "read"] };
		expect(
			await other.emit("before_provider_request", {
				type: "before_provider_request",
				payload,
			}),
		).toBe(payload);
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

	test("tools promote on first call, prompt promotes on agent_end", async () => {
		const app = harness();
		await app.emit("session_start");
		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { max_output_tokens: 64000, tools: ["bash", "read"] },
		});
		expect(first).toEqual({ max_output_tokens: 1024, tools: ["bash", "read"] });

		await app.emit("tool_call", { type: "tool_call", toolName: "read" });
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);

		const secondPayload = {
			max_output_tokens: 64000,
			tools: ["bash", "read", "edit"],
		};
		const second = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: secondPayload,
		});
		expect(second).toEqual({ max_output_tokens: 1024, tools: ["bash", "read", "edit"] });

		await app.emit("agent_end", { type: "agent_end", messages: [] });
		const thirdPayload = {
			max_output_tokens: 64000,
			tools: ["bash", "read", "edit"],
		};
		const third = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: thirdPayload,
		});
		expect(third).toBe(thirdPayload);
	});
});

describe("DSH compatibility mode", () => {
	test("uses the Minimal persona and schemas on a Responses bootstrap", async () => {
		const app = harness({ mode: "dsh" });
		await app.emit("session_start");
		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				instructions: "full OMP prompt",
				max_output_tokens: 64000,
				tools: [
					{
						type: "function",
						name: "bash",
						description: "verbose bash",
						parameters: {
							type: "object",
							properties: { i: {}, command: {}, env: {} },
							required: ["i", "command"],
						},
					},
					{
						type: "function",
						name: "read",
						description: "verbose read",
						parameters: {
							type: "object",
							properties: { i: {}, path: {}, offset: {} },
							required: ["i", "path"],
						},
					},
					{ type: "function", name: "edit" },
				],
			},
		});

		expect(first).toEqual({
			instructions: "You are a helpful software engineer assistant.",
			max_output_tokens: 1024,
			tools: [
				{
					type: "function",
					name: "bash",
					description: "Run a command in a persistent shell.",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
				{
					type: "function",
					name: "read",
					description: "Read a text file.",
					parameters: {
						type: "object",
						properties: { path: { type: "string" } },
						required: ["path"],
					},
				},
			],
		});

		const revised = await app.emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "pwd" },
		});
		expect(revised).toEqual({
			input: {
				command: "pwd",
				i: "Bootstrap repository inspection",
			},
		});
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);

		const concurrent = await app.emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-2",
			toolName: "read",
			input: { path: "README.md" },
		});
		expect(concurrent).toEqual({
			input: {
				path: "README.md",
				i: "Bootstrap repository inspection",
			},
		});
	});
	test("Minimal persona persists across tool results until agent_end", async () => {
		const app = harness({
			mode: "dsh",
			model: { ...deepSeek, api: "openai-responses" },
		});
		await app.emit("session_start");
		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				instructions: "full OMP prompt",
				max_output_tokens: 64000,
				tools: [
					{
						type: "function",
						name: "bash",
						description: "verbose bash",
						parameters: {
							type: "object",
							properties: { i: {}, command: {} },
							required: ["i", "command"],
						},
					},
					{ type: "function", name: "edit" },
				],
			},
		});

		expect(first).toMatchObject({
			instructions: "You are a helpful software engineer assistant.",
			max_output_tokens: 1024,
			tools: [
				{
					type: "function",
					name: "bash",
					description: "Run a command in a persistent shell.",
					parameters: {
						type: "object",
						properties: { command: { type: "string" } },
						required: ["command"],
					},
				},
			],
		});

		await app.emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "pwd" },
		});
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);

		const second = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				instructions: "full OMP prompt",
				max_output_tokens: 64000,
				tools: [
					{
						type: "function",
						name: "bash",
						description: "verbose bash",
						parameters: { type: "object", properties: { i: {}, command: {} } },
					},
					{ type: "function", name: "edit" },
				],
			},
		});

		expect(second).toMatchObject({
			instructions: "You are a helpful software engineer assistant.",
			max_output_tokens: 1024,
		});
		expect((second as { tools: unknown[] }).tools).toHaveLength(2);

		await app.emit("agent_end", { type: "agent_end", messages: [] });
		const third = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				instructions: "full OMP prompt",
				max_output_tokens: 64000,
				tools: [{ type: "function", name: "bash" }],
			},
		});

		expect(third).toMatchObject({
			instructions: "full OMP prompt",
			max_output_tokens: 64000,
		});
	});

	test("replaces Chat system messages and nested function schemas", async () => {
		const app = harness({
			mode: "dsh",
			model: { ...deepSeek, api: "openai-completions" },
		});
		await app.emit("session_start");
		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				max_tokens: 64000,
				messages: [
					{ role: "system", content: "full prompt" },
					{ role: "developer", content: "workspace rules" },
					{ role: "user", content: "Inspect the repository." },
				],
				tools: [
					{
						type: "function",
						function: {
							name: "bash",
							description: "verbose bash",
							parameters: { type: "object", properties: { i: {}, command: {} } },
						},
					},
					{ type: "function", function: { name: "glob" } },
				],
			},
		});

		expect(first).toEqual({
			max_tokens: 1024,
			messages: [
				{
					role: "system",
					content: "You are a helpful software engineer assistant.",
				},
				{ role: "user", content: "Inspect the repository." },
			],
			tools: [
				{
					type: "function",
					function: {
						name: "bash",
						description: "Run a command in a persistent shell.",
						parameters: {
							type: "object",
							properties: { command: { type: "string" } },
							required: ["command"],
						},
					},
				},
			],
		});
	});
});

describe("DSH resident catalog (post-promotion)", () => {
	test("promotion restores the resident set, not the full catalog", async () => {
		const app = harness({
			mode: "dsh",
			tools: ["bash", "read", "edit", "write", "grep", "web_search", "task"],
		});
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["bash", "read"]);

		await app.emit("tool_call", {
			type: "tool_call",
			toolName: "read",
			input: {},
		});
		expect(app.activeTools()).toEqual([
			"bash",
			"read",
			"edit",
			"write",
			"grep",
		]);
	});

	test("the resident catalog stays applied across later un-perturbed requests", async () => {
		const app = harness({
			mode: "dsh",
			tools: ["bash", "read", "edit", "grep", "web_search"],
		});
		await app.emit("session_start");
		await app.emit("message_end", {
			type: "message_end",
			message: { role: "assistant" },
		});
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);

		await app.emit("agent_end", { type: "agent_end", messages: [] });
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);
	});

	test("resumed DeepSeek sessions are narrowed to the resident set", async () => {
		const app = harness({
			mode: "dsh",
			branch: [message("assistant")],
			tools: ["bash", "read", "edit", "grep", "web_search", "task"],
		});
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);
	});

	test("OMP_DEEPSEEK_ANCHOR_RESIDENT replaces the resident set", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_RESIDENT = "bash,read,glob";
		try {
			const app = harness({
				mode: "dsh",
				tools: ["bash", "read", "edit", "grep", "glob", "web_search"],
			});
			await app.emit("session_start");
			await app.emit("tool_call", {
				type: "tool_call",
				toolName: "read",
				input: {},
			});
			expect(app.activeTools()).toEqual(["bash", "read", "glob"]);
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_RESIDENT;
		}
	});

	test("safe mode still restores the full catalog", async () => {
		const app = harness({
			tools: ["bash", "read", "edit", "web_search"],
		});
		await app.emit("session_start");
		await app.emit("tool_call", { type: "tool_call", toolName: "read" });
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "web_search"]);
	});
});

describe("zero-tool anchor mode", () => {
	test("first Chat request carries no tools and a prepended anchor", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS = "1";
		try {
			const app = harness({
				mode: "dsh",
				model: { ...deepSeek, api: "openai-completions" },
			});
			await app.emit("session_start");
			const first = await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload: {
					max_tokens: 64000,
					messages: [
						{ role: "system", content: "full OMP prompt" },
						{ role: "user", content: "Inspect the repository." },
					],
					tools: [
						{ type: "function", name: "bash" },
						{ type: "function", name: "read" },
						{ type: "function", name: "edit" },
					],
				},
			});

			expect(first).toEqual({
				max_tokens: 1024,
				messages: [
					{
						role: "system",
						content: "You are a helpful software engineer assistant.",
					},
					{ role: "user", content: DSH_ANCHOR_TEXT },
					{ role: "user", content: "Inspect the repository." },
				],
				tools: [],
			});
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS;
		}
	});

	test("Responses payloads get a user input item and empty tools", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS = "1";
		try {
			const app = harness({ mode: "dsh" });
			await app.emit("session_start");
			const first = await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload: {
					instructions: "full OMP prompt",
					max_output_tokens: 64000,
					input: [
						{
							type: "message",
							role: "user",
							content: [{ type: "input_text", text: "Inspect." }],
						},
					],
					tools: [{ type: "function", name: "bash" }],
				},
			});

			expect(first).toEqual({
				instructions: "You are a helpful software engineer assistant.",
				max_output_tokens: 1024,
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: DSH_ANCHOR_TEXT }],
					},
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Inspect." }],
					},
				],
				tools: [],
			});
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS;
		}
	});

	test("OMP_DEEPSEEK_ANCHOR_TEXT overrides the anchor notice", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS = "1";
		process.env.OMP_DEEPSEEK_ANCHOR_TEXT = "你是谁";
		try {
			const app = harness({ mode: "dsh" });
			await app.emit("session_start");
			const first = await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload: {
					instructions: "full",
					max_output_tokens: 64000,
					input: [],
					tools: [{ type: "function", name: "bash" }],
				},
			});
			expect((first as { input: { content: { text: string }[] }[] }).input[0])
				.toMatchObject({ role: "user", content: [{ type: "input_text", text: "你是谁" }] });
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS;
			delete process.env.OMP_DEEPSEEK_ANCHOR_TEXT;
		}
	});

	test("OMP_DEEPSEEK_ANCHOR_MAX_TOKENS overrides the bootstrap cap", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS = "2048";
		try {
			const app = harness();
			await app.emit("session_start");
			const first = await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { max_output_tokens: 64000, tools: ["bash", "read"] },
			});
			expect(first).toEqual({ max_output_tokens: 2048, tools: ["bash", "read"] });
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS;
		}
	});

	test("prependAnchor leaves unrecognized payloads untouched", () => {
		expect(prependAnchor({ input: "raw string" }, "anchor")).toEqual({
			input: "raw string",
		});
		expect(prependAnchor(null, "anchor")).toBeNull();
	});
});
