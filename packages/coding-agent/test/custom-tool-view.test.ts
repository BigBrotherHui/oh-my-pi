import { describe, expect, it } from "bun:test";
import { type as arktype } from "@oh-my-pi/omptype";
import type { ToolViewDefinition } from "@oh-my-pi/pi-tui/tools/view";
import type { CustomTool } from "../src/extensibility/custom-tools/types";
import { customToolToDefinition } from "../src/sdk";
import { RegisteredToolAdapter } from "../src/extensibility/extensions/wrapper";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { MessageView, RegisteredTool } from "../src/extensibility/extensions/types";

const sourceInfo = {
	path: "/test/ext.ts",
	source: "extension",
	scope: "project" as const,
	origin: "top-level" as const,
};

describe("custom tool and extension toolView / messageView contract", () => {
	it("forwards toolView and messageView from CustomTool to ToolDefinition", () => {
		const dummyToolView: ToolViewDefinition<unknown, unknown> = { view: () => "custom-view" };
		const dummyMessageView: MessageView = () => "custom-message-view";
		const tool: CustomTool = {
			name: "my_custom_tool",
			label: "My Custom Tool",
			description: "A tool with custom reactive presentation",
			parameters: arktype({ input: "string" }),
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
			toolView: dummyToolView,
			messageView: dummyMessageView,
		};

		const definition = customToolToDefinition(tool);
		expect(definition.name).toBe("my_custom_tool");
		expect(definition.toolView).toBe(dummyToolView);
		expect(definition.messageView).toBe(dummyMessageView);
	});

	it("adapts RegisteredTool with toolView and messageView", () => {
		const dummyToolView: ToolViewDefinition<unknown, unknown> = { view: () => "view" };
		const dummyMessageView: MessageView = () => "msg-view";
		const registeredTool: RegisteredTool = {
			definition: {
				name: "sample_tool",
				label: "Sample Tool",
				description: "sample",
				parameters: arktype({}),
				async execute() {
					return { content: [{ type: "text", text: "done" }] };
				},
				toolView: dummyToolView,
				messageView: dummyMessageView,
			},
			extensionPath: "/test/ext.ts",
			sourceInfo,
		};

		const adapted = new RegisteredToolAdapter(registeredTool, Object.create(null) as ExtensionRunner);
		expect(adapted.toolView).toBe(dummyToolView);
		expect(adapted.messageView).toBe(dummyMessageView);
	});
});
