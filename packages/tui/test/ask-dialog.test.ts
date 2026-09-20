import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "../src/app-keybindings";
import { setKeybindings } from "../src/keybindings";
import { focusNext } from "../src/host/focus";
import { dispatchHostInput } from "../src/host/overlay";
import {
	AskDialogView,
	boundPromptTitle,
	createAskDialogController,
	normalizeDialogQuestions,
	type ExtensionAskDialogSubmitResult,
} from "../src/overlays/ask-dialog";
import { mountForTest } from "../src/testing";

const DOWN = "\x1b[B";
const ENTER = "\n";
const SPACE = " ";

beforeEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	vi.useRealTimers();
});

describe("ask dialog", () => {
	it("keeps stable values while navigating questions and explicitly submitting review", () => {
		let submitted: ExtensionAskDialogSubmitResult | undefined;
		const controller = createAskDialogController(
			[
				{
					id: "first\rquestion",
					question: "First\rquestion?",
					options: [
						{ label: "Alpha\rchoice", value: "alpha-id" },
						{ label: "Beta", value: "beta-id" },
					],
				},
				{
					id: "second",
					question: "Second?",
					options: [
						{ label: "Gamma", value: "gamma-id" },
						{ label: "Delta", value: "delta-id" },
					],
				},
			],
			{
				onSubmit: result => {
					submitted = result;
				},
				onCancel() {},
				async onPrompt() {
					return undefined;
				},
			},
		);

		controller.handleInput(ENTER);
		expect(controller.activeQuestion()).toBe(1);
		controller.handleInput(DOWN);
		controller.handleInput(ENTER);
		expect(controller.isReview()).toBe(true);
		controller.handleInput(ENTER);

		expect(submitted).toEqual({
			kind: "submit",
			results: [
				{
					id: "first\rquestion",
					question: "First\rquestion?",
					options: ["alpha-id", "beta-id"],
					multi: false,
					selectedOptions: ["alpha-id"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
				{
					id: "second",
					question: "Second?",
					options: ["gamma-id", "delta-id"],
					multi: false,
					selectedOptions: ["delta-id"],
					customInput: undefined,
					note: undefined,
					timedOut: undefined,
				},
			],
		});
	});

	it("toggles multiselect choices, retains a freeform answer, and keeps notes attached to their selected row", async () => {
		let submitted: ExtensionAskDialogSubmitResult | undefined;
		const controller = createAskDialogController(
			[
				{
					id: "multi",
					question: "Choose all that apply",
					multi: true,
					options: [
						{ label: "One", value: "one" },
						{ label: "Two", value: "two" },
					],
				},
				{ id: "single", question: "Finish?", options: [{ label: "Continue", value: "continue" }] },
			],
			{
				onSubmit: result => {
					submitted = result;
				},
				onCancel() {},
				onPrompt: async title => (title.startsWith("Note for One") ? "why one" : "custom detail"),
			},
		);

		controller.handleInput("n");
		await Promise.resolve();
		controller.handleInput(SPACE);
		controller.handleInput(DOWN);
		controller.handleInput(SPACE);
		controller.handleInput(DOWN);
		controller.handleInput(ENTER);
		await Promise.resolve();
		expect(controller.activeQuestion()).toBe(1);
		controller.handleInput(ENTER);
		controller.handleInput(ENTER);

		expect(submitted).toMatchObject({
			kind: "submit",
			results: [
				{ id: "multi", selectedOptions: ["one", "two"], customInput: "custom detail", note: "why one" },
				{ id: "single", selectedOptions: ["continue"] },
			],
		});
	});

	it("keeps the dialog open when the freeform editor cancels and dismisses exactly once on Escape", async () => {
		let submitted = 0;
		let cancelled = 0;
		const controller = createAskDialogController(
			[{ id: "choice", question: "Choose?", options: [{ label: "Known" }] }],
			{
				onSubmit() {
					submitted++;
				},
				onCancel() {
					cancelled++;
				},
				async onPrompt() {
					return undefined;
				},
			},
		);

		controller.handleInput(DOWN);
		controller.handleInput(ENTER);
		await Promise.resolve();
		expect(submitted).toBe(0);
		expect(cancelled).toBe(0);

		controller.handleInput("\x1b");
		controller.handleInput("\x1b");
		expect(cancelled).toBe(1);
	});

	it("defers timeout until a pending custom prompt resolves, then fills unanswered recommendations", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<string | undefined>();
		let submitted: ExtensionAskDialogSubmitResult | undefined;
		let timedOut = 0;
		const controller = createAskDialogController(
			[
				{ id: "custom", question: "Custom?", options: [{ label: "Fallback", value: "fallback" }] },
				{
					id: "recommended",
					question: "Recommended?",
					recommended: 1,
					options: [
						{ label: "First", value: "first" },
						{ label: "Second", value: "second" },
					],
				},
			],
			{
				onSubmit: result => {
					submitted = result;
				},
				onCancel() {},
				onPrompt: () => deferred.promise,
			},
			{
				timeout: 1000,
				onTimeout: () => {
					timedOut++;
				},
			},
		);

		controller.handleInput(DOWN);
		controller.handleInput(ENTER);
		vi.advanceTimersByTime(1000);
		expect(submitted).toBeUndefined();
		deferred.resolve("typed answer");
		await Promise.resolve();
		await Promise.resolve();

		expect(timedOut).toBe(1);
		expect(submitted).toMatchObject({
			results: [
				{ id: "custom", selectedOptions: [], customInput: "typed answer", timedOut: undefined },
				{ id: "recommended", selectedOptions: ["second"], timedOut: true },
			],
		});
	});

	it("keeps full prompt context for the receiving native editor", () => {
		const title = boundPromptTitle("Custom answer: ", "Explain\tthis\nvery detailed question");

		expect(title).toBe("Custom answer:\nExplain this very detailed question");
	});

	it("routes answer keys to an active draft guard instead of submitting", () => {
		const forwarded: string[] = [];
		let submitted = 0;
		const controller = createAskDialogController(
			[{ id: "choice", question: "Choose?", options: [{ label: "Known" }] }],
			{
				onSubmit() {
					submitted++;
				},
				onCancel() {},
				async onPrompt() {
					return undefined;
				},
			},
			{
				inputGuard: {
					isBlocked: () => true,
					handleInput: data => forwarded.push(data),
					hint: "Finish the draft",
				},
			},
		);

		controller.handleInput(ENTER);

		expect(forwarded).toEqual([ENTER]);
		expect(submitted).toBe(0);
	});

	it("renders sanitized question cards, description, every preview, controls, and active cursor", () => {
		const questions = normalizeDialogQuestions([
			{
				id: "pick\rnow",
				question: "Pick\rnow?",
				header: "Primary\rchoice",
				options: [
					{ label: "Retry\rnow", description: "First\rpreview", preview: "PREVIEW-ALPHA" },
					{ label: "Retry now (Recommended)", preview: "PREVIEW-BRAVO" },
				],
				recommended: 0,
			},
		]);
		const controller = createAskDialogController(questions, {
			onSubmit() {},
			onCancel() {},
			async onPrompt() {
				return undefined;
			},
		});
		const root = mountForTest(() =>
			AskDialogView({
				questions,
				controller,
				callbacks: {
					onSubmit() {},
					onCancel() {},
					async onPrompt() {
						return undefined;
					},
				},
			}),
		);
		try {
			focusNext(root.root.node);
			const rendered = root.text(60).join("\n");
			expect(rendered).toContain("Pick now?");
			expect(rendered).toContain("Retry now (Recommended)");
			expect(rendered).toContain("Retry now (Recommended) (2)");
			expect(rendered).toContain("First preview");
			expect(rendered).toContain("PREVIEW-ALPHA");
			expect(rendered).toContain("PREVIEW-BRAVO");
			expect(rendered).toContain("Other (type your own)");
			expect(rendered).toContain("Enter select");
			expect(rendered).not.toContain("\r");

			dispatchHostInput(root.root, DOWN);
			expect(controller.cursor()).toBe(1);
			expect(root.text(60).join("\n")).toContain("❯");

			for (const row of root.text(12)) expect(row.length).toBeLessThanOrEqual(12);
		} finally {
			root.dispose();
		}
	});
});
