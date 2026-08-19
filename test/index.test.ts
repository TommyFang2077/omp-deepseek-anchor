import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import {
	capOutputTokens,
	DSH_ANCHOR_TEXT,
	formatStatus,
	hasPromotionSignal,
	isDeepSeekModel,
	parseMaxTokens,
	prependAnchor,
	bootstrapPayload,
} from "../src/anchor";
import deepSeekAnchor, { STATUS_COMMAND } from "../src/index";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type TestModel = { provider: string; id: string; api: string };

const deepSeek = {
	provider: "ccs-codex-deepseek",
	id: "deepseek-v4-pro",
	api: "openai-responses",
};
const glmViaDeepSeekProvider = {
	provider: "ccs-codex-deepseek",
	id: "glm-5.3",
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
	const infos: string[] = [];
	const notifications: string[] = [];
	const commands = new Map<string, { description?: string; handler: unknown }>();
	let activeTools = [...tools];
	// The fake only implements the context surface exercised by this extension.
	const ctx = {
		model,
		sessionManager: { getBranch: () => branch },
		ui: {
			notify(message: string, type?: string) {
				notifications.push(`${type ?? "info"}: ${message}`);
			},
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, options: { description?: string; handler: unknown }) {
			commands.set(name, options);
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
			info(text: string) {
				infos.push(text);
			},
		},
	};

	deepSeekAnchor(pi as unknown as ExtensionAPI, mode);

	return {
		ctx,
		toolSets,
		warnings,
		infos,
		notifications,
		commands,
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
	test("matches DeepSeek by model id, not a shared provider route", () => {
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
			isDeepSeekModel(
				glmViaDeepSeekProvider as unknown as ExtensionContext["model"],
			),
		).toBe(false);
		expect(
			isDeepSeekModel(claude as unknown as ExtensionContext["model"]),
		).toBe(false);
	});

	test("leaves GLM-5.3 at max thinking unmodified through a DeepSeek route", async () => {
		const app = harness({ model: glmViaDeepSeekProvider, mode: "dsh" });
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["bash", "read", "edit", "grep"]);
		const payload = { instructions: "full prompt", tools: ["bash", "read", "edit"] };
		expect(
			await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload,
			}),
		).toBe(payload);
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
	test("fresh DeepSeek sessions start with bash and edit", async () => {
		const app = harness();
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["bash", "edit"]);
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
			max_output_tokens: 64000,
			tools: [
				{ type: "function", name: "bash" },
				{ type: "function", function: { name: "edit" } },
			],
		});
		expect(app.activeTools()).toEqual(["bash", "edit"]);

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

	test("missing bash fails open", async () => {
		const app = harness({ tools: ["read", "edit"] });
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["read", "edit"]);
		expect(app.warnings).toHaveLength(1);
	});

	test("bash+read without edit fails open", async () => {
		const app = harness({ tools: ["bash", "read"] });
		await app.emit("session_start");
		expect(app.activeTools()).toEqual(["bash", "read"]);
		expect(app.warnings[0]).toContain("bash and edit");
	});
});

describe("first-request output cap", () => {
	test("leaves the payload unchanged when no cap is set", () => {
		expect(parseMaxTokens(undefined)).toBeUndefined();
		expect(parseMaxTokens("")).toBeUndefined();
		expect(parseMaxTokens("1024")).toBe(1024);
		expect(
			capOutputTokens({ max_output_tokens: 64000 }, "openai-responses"),
		).toEqual({ max_output_tokens: 64000 });
	});

	test("caps Responses and Chat payloads without raising a lower limit", () => {
		expect(
			capOutputTokens({ max_output_tokens: 64000 }, "openai-responses", 1024),
		).toEqual({ max_output_tokens: 1024 });
		expect(
			capOutputTokens({ max_tokens: 64000 }, "openai-completions", 1024),
		).toEqual({ max_tokens: 1024 });
		expect(
			capOutputTokens({ max_tokens: 512 }, "openai-completions", 1024),
		).toEqual({
			max_tokens: 512,
		});
	});

	test("tools promote on first call, prompt promotes on agent_end", async () => {
		const app = harness();
		await app.emit("session_start");
		const first = await app.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { max_output_tokens: 64000, tools: ["bash", "edit"] },
		});
		expect(first).toEqual({ max_output_tokens: 64000, tools: ["bash", "edit"] });

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
		expect(second).toEqual({
			max_output_tokens: 64000,
			tools: ["bash", "read", "edit"],
		});

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
			max_output_tokens: 64000,
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
					name: "edit",
					description: "Replace a string in a text file.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							old_string: { type: "string" },
							new_string: { type: "string" },
						},
						required: ["path", "old_string", "new_string"],
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
			toolName: "edit",
			input: { path: "README.md", old_string: "a", new_string: "b" },
		});
		expect(concurrent).toEqual({
			input: {
				path: "README.md",
				old_string: "a",
				new_string: "b",
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
			max_output_tokens: 64000,
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
					name: "edit",
					description: "Replace a string in a text file.",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
							old_string: { type: "string" },
							new_string: { type: "string" },
						},
						required: ["path", "old_string", "new_string"],
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
			max_output_tokens: 64000,
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
			max_tokens: 64000,
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
		expect(app.activeTools()).toEqual(["bash", "edit"]);

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
				max_tokens: 64000,
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
				max_output_tokens: 64000,
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

	test("OMP_DEEPSEEK_ANCHOR_MAX_TOKENS opts into a first-request cap", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS = "2048";
		try {
			const app = harness();
			await app.emit("session_start");
			const first = await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { max_output_tokens: 64000, tools: ["bash", "edit"] },
			});
			expect(first).toEqual({ max_output_tokens: 2048, tools: ["bash", "edit"] });
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

describe("payload transform purity", () => {
	test("reapplying the bootstrap transform is a no-op", () => {
		const payload = {
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
				{
					type: "function",
					function: {
						name: "edit",
						description: "verbose edit",
						parameters: {
							type: "object",
							properties: { i: {}, path: {} },
							required: ["i", "path"],
						},
					},
				},
			],
		};
		const once = bootstrapPayload(
			payload,
			"openai-responses",
			"dsh",
			true,
			false,
			1024,
		);
		const twice = bootstrapPayload(
			once,
			"openai-responses",
			"dsh",
			true,
			false,
			1024,
		);
		expect(twice).toEqual(once);
		expect(once).toMatchObject({
			instructions: "You are a helpful software engineer assistant.",
			max_output_tokens: 1024,
		});
		expect((once as { tools: unknown[] }).tools).toHaveLength(2);
	});

	test("non-object payloads pass through unchanged", () => {
		for (const payload of [null, undefined, 42, "text", ["bash"]]) {
			expect(bootstrapPayload(payload, "openai-responses", "dsh", true, true, 1024)).toBe(payload);
		}
	});

	test("hasPromotionSignal fails open without a session manager", () => {
		expect(hasPromotionSignal({} as never)).toBe(false);
		expect(
			hasPromotionSignal({
				sessionManager: undefined,
			} as never),
		).toBe(false);
	});
});

describe("status command", () => {
	test("registers a read-only status command", () => {
		const app = harness();
		const registered = app.commands.get(STATUS_COMMAND);
		expect(registered).toBeDefined();
		expect(registered?.description).toContain("runtime state");
	});

	test("reports live mode, phase, and catalog state", async () => {
		const app = harness();
		const handler = app.commands.get(STATUS_COMMAND)
			?.handler as (args: string, ctx: ExtensionContext) => Promise<void>;
		await handler("", app.ctx);
		expect(app.notifications).toHaveLength(1);
		expect(app.notifications[0]).toContain("mode=safe");
		expect(app.notifications[0]).toContain("phase=bootstrap");
		expect(app.notifications[0]).toContain("active tools: bash, read, edit, grep");
	});

	test("falls back to the logger when no UI is available", async () => {
		const app = harness();
		const handler = app.commands.get(STATUS_COMMAND)
			?.handler as (args: string, ctx: ExtensionContext) => Promise<void>;
		const ctx = { ...app.ctx } as { ui?: unknown };
		delete ctx.ui;
		await handler("", ctx as unknown as ExtensionContext);
		expect(app.notifications).toHaveLength(0);
		expect(app.infos.some((info) => info.includes("mode=safe"))).toBe(true);
	});

	test("dsh bootstrap activation is reported", async () => {
		const app = harness({ mode: "dsh" });
		const handler = app.commands.get(STATUS_COMMAND)
			?.handler as (args: string, ctx: ExtensionContext) => Promise<void>;
		await app.emit("session_start");
		expect(app.infos.some((line) => line.includes("/deepseek-anchor-status"))).toBe(true);
		await handler("", app.ctx);
		expect(app.notifications[0]).toContain("mode=dsh");
		expect(app.notifications[0]).toContain("phase=bootstrap");
		expect(app.notifications[0]).toContain("minimal persona: true");
	});
});

describe("configuration validation", () => {
	test("invalid OMP_DEEPSEEK_ANCHOR_MODE warns and falls back to safe", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_MODE = "banana";
		try {
			const app = harness();
			expect(
				app.warnings.some((w) => w.includes('OMP_DEEPSEEK_ANCHOR_MODE="banana"')),
			).toBe(true);
			await app.emit("session_start");
			expect(app.activeTools()).toEqual(["bash", "edit"]);
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_MODE;
		}
	});

	test("invalid OMP_DEEPSEEK_ANCHOR_MAX_TOKENS warns and disables the cap", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS = "abc";
		try {
			const app = harness();
			expect(
				app.warnings.some((w) =>
					w.includes('OMP_DEEPSEEK_ANCHOR_MAX_TOKENS="abc"'),
				),
			).toBe(true);
			await app.emit("session_start");
			const first = await app.emit("before_provider_request", {
				type: "before_provider_request",
				payload: { max_output_tokens: 64000, tools: ["bash", "edit"] },
			});
			expect(first).toEqual({
				max_output_tokens: 64000,
				tools: ["bash", "edit"],
			});
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_MAX_TOKENS;
		}
	});

	test("resident tools missing from the catalog warn once and are skipped", async () => {
		process.env.OMP_DEEPSEEK_ANCHOR_RESIDENT = "bash,read,web_search";
		try {
			const app = harness({ mode: "dsh", tools: ["bash", "read", "edit"] });
			await app.emit("session_start");
			await app.emit("tool_call", { type: "tool_call", toolName: "read" });
			expect(app.activeTools()).toEqual(["bash", "read"]);
			const mentions = app.warnings.filter((w) => w.includes("web_search"));
			expect(mentions).toHaveLength(1);
			expect(mentions[0]).toContain("skipped");
		} finally {
			delete process.env.OMP_DEEPSEEK_ANCHOR_RESIDENT;
		}
	});

	test("bootstrap activation logs a one-time info line", async () => {
		const app = harness();
		await app.emit("session_start");
		await app.emit("session_start");
		expect(app.infos).toHaveLength(1);
		expect(app.infos[0]).toContain("narrowed to bash+edit");
	});
});

describe("status formatting", () => {
	test("formatStatus renders mode, phase, and catalog state", () => {
		const text = formatStatus({
			mode: "dsh",
			model: "ccs-codex-deepseek/deepseek-v4-pro",
			promoted: false,
			active: true,
			toolsNarrowed: true,
			minimalPromptActive: true,
			zeroTools: true,
			maxTokens: 1024,
			residentTools: ["bash", "read", "edit"],
			activeTools: ["bash", "edit"],
		});
		expect(text).toContain("mode=dsh");
		expect(text).toContain("phase=bootstrap");
		expect(text).toContain("zero-tool anchor: on");
		expect(text).toContain("first-request cap: 1024");
		expect(text).toContain("resident tools: bash, read, edit");
		expect(text).toContain("active tools: bash, edit");
	});

	test("formatStatus renders promoted and inactive phases", () => {
		const promoted = formatStatus({
			mode: "dsh",
			model: "ccs-codex-deepseek/deepseek-v4-pro",
			promoted: true,
			active: true,
			toolsNarrowed: false,
			minimalPromptActive: false,
			zeroTools: false,
			residentTools: [],
			activeTools: [],
		});
		expect(promoted).toContain("phase=promoted");

		const inactive = formatStatus({
			mode: "safe",
			model: "anthropic/claude-sonnet-5",
			promoted: false,
			active: false,
			toolsNarrowed: false,
			minimalPromptActive: false,
			zeroTools: false,
			residentTools: [],
			activeTools: [],
		});
		expect(inactive).toContain("phase=inactive");
		expect(inactive).toContain("anchor: inactive");
	});
});
