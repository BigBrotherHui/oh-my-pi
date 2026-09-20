import { beforeEach, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import {
	createPlanReviewController,
	PlanReviewOverlayView,
	type PlanReviewAnnotationState,
} from "../src/overlays/plan-review-overlay";
import { renderToText } from "../src/testing";

const darkTheme = await getThemeByName("dark");
const OPTIONS = ["Approve and execute", "Approve and compact context", "Approve and keep context", "Refine plan"];
const SECTION_PLAN =
	"# Overview\n\nintro body\n\n## Goal\n\ngoal body\n\n## Steps\n\nstep body\n\n# Risks\n\nrisk body\n";

describe("plan review overlay", () => {
	beforeEach(() => {
		if (!darkTheme) throw new Error("Failed to load dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders the plan, review actions, and focus-aware footer in one frame", () => {
		const controller = createPlanReviewController(
			"# My Plan\n\nstep one then step two",
			{ promptTitle: "Plan mode - next step", options: OPTIONS, helpText: "esc cancel" },
			{ onPick() {}, onCancel() {}, onCopyPlan() {} },
		);

		const text = renderToText(
			() =>
				PlanReviewOverlayView({
					controller,
					options: { promptTitle: "Plan mode - next step", options: OPTIONS, helpText: "esc cancel" },
				}),
			80,
		).join("\n");

		expect(text).toContain("Plan Review");
		expect(text).toContain("My Plan");
		expect(text).toContain("step one then step two");
		expect(text).toContain("Plan mode - next step");
		expect(text).toContain("Approve and execute");
		expect(text).toContain("↑↓ select · ⏎ confirm · c copy · tab regions · esc cancel");
	});

	it("commits one enabled approval choice and ignores later input while it is applying", () => {
		const picked: string[] = [];
		const cancelled: string[] = [];
		const controller = createPlanReviewController(
			"plan",
			{ options: OPTIONS, disabledIndices: [2] },
			{ onPick: label => picked.push(label), onCancel: () => cancelled.push("cancel") },
		);

		controller.handleInput("\x1b[B");
		controller.handleInput("\x1b[B");
		controller.handleInput("\r");
		controller.handleInput("\x1b[B");
		controller.handleInput("\r");
		controller.cancel();

		expect(picked).toEqual(["Refine plan"]);
		expect(controller.committed()).toBe(true);
		expect(controller.committedLabel()).toBe("Refine plan");
		expect(cancelled).toEqual([]);
	});

	it("keeps selection independent from the model tier slider", () => {
		const tiers: number[] = [];
		const picked: string[] = [];
		const controller = createPlanReviewController(
			"plan",
			{
				options: OPTIONS,
				slider: {
					caption: "continue with",
					index: 0,
					segments: [{ label: "default" }, { label: "slow", detail: "opus" }],
					onChange: index => tiers.push(index),
				},
			},
			{ onPick: label => picked.push(label), onCancel() {} },
		);

		controller.handleInput("\x1b[C");
		controller.handleInput("\x1b[C");
		controller.handleInput("\x1b[D");
		controller.handleInput("\r");

		expect(tiers).toEqual([1, 0]);
		expect(picked).toEqual(["Approve and execute"]);
	});

	it("exposes the historical ToC, deletes a selected section tree, and restores it with undo", () => {
		const edits: string[] = [];
		const controller = createPlanReviewController(
			SECTION_PLAN,
			{ options: OPTIONS },
			{ onPick() {}, onCancel() {}, onPlanEdited: content => edits.push(content) },
		);

		expect(controller.toc().map(index => controller.sections()[index]?.title)).toEqual([
			"Overview",
			"Goal",
			"Steps",
			"Risks",
		]);
		controller.focusTocAt(1);
		controller.handleInput("d");
		expect(edits.at(-1)).not.toContain("## Goal");
		expect(edits.at(-1)).toContain("## Steps");

		controller.handleInput("u");
		expect(edits.at(-1)).toBe(SECTION_PLAN);
	});

	it("copies the current edited plan instead of the original document", () => {
		const copied: string[] = [];
		const controller = createPlanReviewController(
			SECTION_PLAN,
			{ options: OPTIONS },
			{
				onPick() {},
				onCancel() {},
				onCopyPlan: content => {
					copied.push(content);
				},
			},
		);

		controller.focusTocAt(1);
		controller.handleInput("d");
		controller.handleInput("c");

		expect(copied).toEqual(["# Overview\n\nintro body\n\n## Steps\n\nstep body\n\n# Risks\n\nrisk body\n"]);
	});

	it("emits section annotations as serializable refinement feedback", () => {
		const feedback: string[] = [];
		const states: PlanReviewAnnotationState[] = [];
		const controller = createPlanReviewController(
			SECTION_PLAN,
			{ options: OPTIONS },
			{
				onPick() {},
				onCancel() {},
				onFeedbackChange: value => feedback.push(value),
				onAnnotationStateChange: state => states.push(state),
			},
		);

		controller.focusTocAt(0);
		controller.handleInput("a");
		controller.setAnnotationDraft("needs detail");
		controller.submitAnnotation();

		expect(states.at(-1)).toMatchObject({
			annotations: [{ section: { title: "Overview" }, target: { kind: "section" }, note: "needs detail" }],
		});
		expect(feedback.at(-1)).toContain("## Overview\n- needs detail\n");
		expect(controller.sections()[0]?.annotations).toHaveLength(1);
	});

	it("drops stale restored annotations and clears refinement feedback", () => {
		const states: PlanReviewAnnotationState[] = [];
		const feedback: string[] = [];
		const controller = createPlanReviewController(
			"# B\n\nbeta body\n",
			{
				options: OPTIONS,
				annotationState: {
					annotations: [{ section: { index: 0, title: "A" }, target: { kind: "section" }, note: "stale note" }],
				},
			},
			{
				onPick() {},
				onCancel() {},
				onAnnotationStateChange: state => states.push(state),
				onFeedbackChange: value => feedback.push(value),
			},
		);

		expect(controller.annotationState()).toEqual({ annotations: [] });
		expect(states.at(-1)).toEqual({ annotations: [] });
		expect(feedback.at(-1)).toBe("");
	});

	it("keeps a cancelled annotation editor draft and commits its accepted replacement", () => {
		let commit: ((text: string | null) => void) | undefined;
		const feedback: string[] = [];
		const controller = createPlanReviewController(
			SECTION_PLAN,
			{ options: OPTIONS, externalEditorLabel: "ctrl+e" },
			{
				onPick() {},
				onCancel() {},
				onFeedbackChange: value => feedback.push(value),
				onAnnotationExternalEditor: (_draft, next) => {
					commit = next;
				},
			},
		);

		controller.focusTocAt(0);
		controller.handleInput("a");
		controller.setAnnotationDraft("draft");
		controller.openAnnotationExternalEditor();
		commit?.(null);
		expect(controller.annotationDraft()).toBe("draft");
		expect(controller.annotating()).toBe(true);

		controller.openAnnotationExternalEditor();
		commit?.("- add rollback command\n- include smoke test");
		expect(controller.annotating()).toBe(false);
		expect(feedback.at(-1)).toContain("```md\n- add rollback command\n- include smoke test\n```");
	});

	it("resets scroll, undo history, and deleted-section feedback on an external editor replacement", () => {
		const feedback: string[] = [];
		const controller = createPlanReviewController(
			SECTION_PLAN,
			{ options: OPTIONS },
			{ onPick() {}, onCancel() {}, onFeedbackChange: value => feedback.push(value) },
		);

		controller.focusTocAt(1);
		controller.handleInput("d");
		expect(feedback.at(-1)).toContain("Remove these sections:");
		controller.setPlanContent("# Fresh plan\n\nnew body\n");
		controller.handleInput("u");

		expect(controller.plan()).toBe("# Fresh plan\n\nnew body\n");
		expect(controller.scrollOffset()).toBe(0);
		expect(feedback.at(-1)).toBe("");
	});
});
