import { afterAll, afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { executeJs } from "@oh-my-pi/pi-coding-agent/eval/js/executor";
import { namespaceSessionId as namespaceJs } from "@oh-my-pi/pi-coding-agent/eval/js/index";
import { createMacroExpander } from "@oh-my-pi/pi-coding-agent/eval/macro-expand";
import { clearAllMacroDefinitions } from "@oh-my-pi/pi-coding-agent/eval/macro-registry";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { namespaceSessionId as namespacePy } from "@oh-my-pi/pi-coding-agent/eval/py/index";

const EVAL_SESSION = "macro-it";
const token = (body: string): string => `@[[${body}]]`;

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		taskDepth: 0,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => null,
		getSessionId: () => "macro-it-session",
		getEvalSessionId: () => EVAL_SESSION,
	} as unknown as ToolSession;
}

/** Minimal finalized assistant message carrying the given text + one tool call. */
function assistantMessage(text: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: "tc1", name: "write", arguments: args },
		],
	} as unknown as AssistantMessage;
}

afterEach(() => {
	clearAllMacroDefinitions();
});

afterAll(async () => {
	clearAllMacroDefinitions();
	await disposeAllKernelSessions().catch(() => undefined);
	await disposeAllVmContexts().catch(() => undefined);
});

describe("macro expansion end-to-end", () => {
	it("expands registered python macros in text and tool-call args against the live kernel", async () => {
		const session = makeSession();
		const setup = await executePython(
			`def path_for(name):
    return '/tmp/run/' + name

defmacro("pow2", lambda x: x ** 2)
defmacro("constant", 7)
defmacro("path_for", path_for)`,
			{
				cwd: session.cwd,
				sessionId: namespacePy(EVAL_SESSION),
			},
		);
		expect(setup.exitCode).toBe(0);

		const expand = createMacroExpander(session);
		const msg = assistantMessage(`10² = ${token("pow2(10)")}, c=${token("constant")}`, {
			path: token('path_for("log.txt")'),
			nested: { deep: `n=${token("pow2(3)")}` },
		});
		await expand(msg);

		expect((msg.content[0] as { text: string }).text).toBe("10² = 100, c=7");
		const toolArgs = (msg.content[1] as { arguments: Record<string, unknown> }).arguments;
		expect(toolArgs.path).toBe("/tmp/run/log.txt");
		expect((toolArgs.nested as { deep: string }).deep).toBe("n=9");
	});

	it("expands python macros when user code shadows json", async () => {
		const session = makeSession();
		const setup = await executePython('json = 1\ndefmacro("pow2_shadow", lambda x: x ** 2)', {
			cwd: session.cwd,
			sessionId: namespacePy(EVAL_SESSION),
		});
		expect(setup.exitCode).toBe(0);

		const expand = createMacroExpander(session);
		const msg = assistantMessage(`value=${token("pow2_shadow(4)")}`, {});
		await expand(msg);

		expect((msg.content[0] as { text: string }).text).toBe("value=16");
	});

	it("rejects python macro registration in per-call kernel mode", async () => {
		const session = makeSession();
		const setup = await executePython('defmacro("per_call_only", 1)', {
			cwd: session.cwd,
			sessionId: namespacePy(EVAL_SESSION),
			kernelMode: "per-call",
		});

		expect(setup.exitCode).toBe(1);
		expect(setup.output).toContain("Python defmacro requires the persistent session kernel");

		const expand = createMacroExpander(session);
		const msg = assistantMessage(`value=${token("per_call_only")}`, {});
		await expand(msg);

		expect((msg.content[0] as { text: string }).text).toBe(`value=${token("per_call_only")}`);
	});

	it("expands registered js macros and leaves unknown names literal", async () => {
		const session = makeSession();
		await executeJs('defmacro("up", s => String(s).toUpperCase()); defmacro("tag", "v1");', {
			cwd: session.cwd,
			sessionId: namespaceJs(EVAL_SESSION),
			session,
		});

		const expand = createMacroExpander(session);
		const msg = assistantMessage(`${token('up("hi")')} build ${token("tag")} and ${token("missing")}`, {});
		await expand(msg);

		expect((msg.content[0] as { text: string }).text).toBe(`HI build v1 and ${token("missing")}`);
	});

	it("leaves a macro literal when both runtimes register the same name", async () => {
		const session = makeSession();
		await executePython('defmacro("dupe", "py")', { cwd: session.cwd, sessionId: namespacePy(EVAL_SESSION) });
		await executeJs('defmacro("dupe", "js")', {
			cwd: session.cwd,
			sessionId: namespaceJs(EVAL_SESSION),
			session,
		});

		const expand = createMacroExpander(session);
		const msg = assistantMessage(`winner=${token("dupe")}`, {});
		await expand(msg);

		expect((msg.content[0] as { text: string }).text).toBe(`winner=${token("dupe")}`);
	});

	it("is a no-op for messages without macros (fast path)", async () => {
		const session = makeSession();
		const expand = createMacroExpander(session);
		const msg = assistantMessage("plain text, nothing to expand", { path: "/etc/hosts" });
		await expand(msg);
		expect((msg.content[0] as { text: string }).text).toBe("plain text, nothing to expand");
		expect((msg.content[1] as { arguments: Record<string, unknown> }).arguments.path).toBe("/etc/hosts");
	});
});
