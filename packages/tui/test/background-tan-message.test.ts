import { describe, expect, it } from "bun:test";
import { BackgroundTanDispatchView } from "../src/chat/background-tan-message";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type BackgroundTanDispatchDetails,
	type CustomMessage,
} from "../src/chat/messages";
import { isTightLayout, setTightLayout } from "../src/reactive";
import { mountForTest, renderToRows, renderToText } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";

function dispatchMessage(
	details?: Partial<BackgroundTanDispatchDetails>,
): CustomMessage<Partial<BackgroundTanDispatchDetails>> {
	return {
		role: "custom",
		customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
		// The persisted content is the full system-notice the model reads; the
		// renderer must NOT surface it in the transcript.
		content: '<system-notice reason="background_task_dispatched">raw block</system-notice>',
		display: true,
		...(details === undefined ? {} : { details }),
		attribution: "user",
		timestamp: Date.now(),
	};
}

describe("createBackgroundTanDispatchBlock", () => {
	it("renders one compact line with the job id and work preview, not the raw notice", () => {
		const message = dispatchMessage({
			jobId: "job-42",
			work: "investigate the cache reuse path",
			sessionFile: "/x/Tan-1.jsonl",
		});

		const lines = renderToRows(() => BackgroundTanDispatchView({ message }), 120).filter(
			line => line.trim().length > 0,
		);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("job-42");
		expect(lines[0]).toContain("investigate the cache reuse path");
		expect(lines[0]).not.toContain("system-notice");
	});

	it("truncates an overlong work preview so the line stays a single pill", () => {
		const message = dispatchMessage({ jobId: "job-7", work: "x".repeat(200), sessionFile: "/x/Tan-2.jsonl" });

		const line =
			renderToRows(() => BackgroundTanDispatchView({ message }), 120).find(rendered => rendered.includes("job-7")) ??
			"";

		expect(line).toContain("…");
		expect(line).not.toContain("x".repeat(80));
	});

	it("keeps the historical output-status segments and wraps them in a narrow transcript", () => {
		const message = dispatchMessage({ jobId: "job-wide", work: "audit agent state", sessionFile: "/x/Tan-3.jsonl" });
		const root = mountForTest(() => BackgroundTanDispatchView({ message }), {
			width: 120,
			theme: loadThemeSync("dark"),
		});
		try {
			const theme = root.root.theme;
			expect(root.text()[0]?.trimEnd()).toBe(
				` ${theme.symbol("icon.output")} Tangent dispatched [task] job-wide ${theme.symbol("format.dash")} audit agent state`,
			);

			const narrow = root.text(24);
			const narrowText = narrow.map(line => line.trim()).join(" ");
			expect(narrow).toHaveLength(3);
			expect(narrowText).toContain(`[task] job-wide ${theme.symbol("format.dash")} audit agent state`);
			for (const line of narrow) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(24);
		} finally {
			root.dispose();
		}
	});

	it("tracks the live tight-layout setting", () => {
		const wasTight = isTightLayout();
		setTightLayout(false);
		const root = mountForTest(
			() =>
				BackgroundTanDispatchView({
					message: dispatchMessage({ jobId: "job-tight", work: "inspect", sessionFile: "/x/Tan-4.jsonl" }),
				}),
			{ width: 80, theme: loadThemeSync("dark") },
		);
		try {
			const outputGlyph = root.root.theme.symbol("icon.output");
			expect(root.text()[0]?.startsWith(` ${outputGlyph}`)).toBeTrue();

			setTightLayout(true);

			expect(root.text()[0]?.startsWith(outputGlyph)).toBeTrue();
		} finally {
			root.dispose();
			setTightLayout(wasTight);
		}
	});

	it("retains the legacy fallback when dispatch details are absent", () => {
		const text = renderToText(() => BackgroundTanDispatchView({ message: dispatchMessage() }), 80).join("\n");

		expect(text).toContain("[task] unknown");
		expect(text).not.toContain("raw block");
	});
});
