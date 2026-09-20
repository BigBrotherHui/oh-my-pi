import { describe, expect, it } from "bun:test";
import { paintComposerContent, paintComposerText, type ComposerStyle } from "../src/components/composer";
import {
	ComposerShapePreviewView,
	renderComposerShapePreview,
	type ComposerPreviewStatusSource,
} from "../src/overlays/composer-shape-preview";
import { StatusLineView } from "../src/status-line";
import { getComposerShapeOptions, installExtensionComposerShape } from "../src/overlays/composer-shape-registry";
import { createSignal, type JSX } from "../src/reactive";
import { mountForTest } from "../src/testing";
import { loadThemeSync } from "../src/theme/loader";

function previewStatus(): ComposerPreviewStatusSource {
	const [revision] = createSignal(0);
	return {
		revision,
		clockCadence: () => undefined,
		previewLayout: () => "band",
		view(_now, layout, title): JSX.Element {
			const label =
				layout === undefined
					? "FOOTER"
					: layout === "box"
						? "TOPBAR"
						: layout === "band"
							? "BAND"
							: layout === "plain-right"
								? "CHIP"
								: "BOTTOM";
			return (
				<text>
					{label} {title ?? ""}
				</text>
			);
		},
	};
}

function renderPreview(
	shape: string,
	width = 80,
	status: ComposerPreviewStatusSource | undefined = undefined,
): string[] {
	const root = mountForTest(() => renderComposerShapePreview(shape, status), { width, theme: loadThemeSync("dark") });
	try {
		return root.text();
	} finally {
		root.dispose();
	}
}

describe("composer shape preview", () => {
	it("keeps the standalone source footer-only while previews explicitly select their layout", () => {
		const root = mountForTest(() => <StatusLineView source={previewStatus()} />, {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		try {
			expect(root.text().join("\n")).toContain("FOOTER");
			expect(root.text().join("\n")).not.toContain("BAND");
		} finally {
			root.dispose();
		}
	});

	it("mounts real status views at each candidate attachment point", () => {
		const status = previewStatus();
		const box = renderPreview("box", 80, status).join("\n");
		expect(box).toContain("TOPBAR omp");
		expect(box).not.toContain("BOTTOM omp");

		const band = renderPreview("band", 80, status).join("\n");
		expect(band).toContain("BAND omp");
		expect(band).not.toContain("BOTTOM omp");

		for (const shape of ["claude", "rule"]) {
			const preview = renderPreview(shape, 80, status).join("\n");
			expect(preview).toContain("CHIP omp");
			expect(preview).toContain("BOTTOM omp");
		}

		for (const shape of ["pi", "borderless", "field", "rail"]) {
			const preview = renderPreview(shape, 80, status).join("\n");
			expect(preview).not.toContain("CHIP omp");
			expect(preview).toContain("BOTTOM omp");
		}
	});

	it("updates the retained preview when the highlighted shape changes", () => {
		const [shape, setShape] = createSignal("band");
		const root = mountForTest(() => <ComposerShapePreviewView shape={shape()} status={previewStatus()} />, {
			width: 80,
			theme: loadThemeSync("dark"),
		});
		try {
			expect(root.text().join("\n")).toContain("BAND omp");
			setShape("box");
			expect(root.text().join("\n")).toContain("TOPBAR omp");
		} finally {
			root.dispose();
		}
	});

	it("uses registered extension styles in the native editor preview", () => {
		const style: ComposerStyle = {
			id: "extension-dock",
			sideBorders: false,
			verticalChrome: 1,
			statusAttachment: "none",
			bottomBar: "full",
			bottomBarGap: false,
			defaultPromptGutter: "EXT ",
			defaultPaddingX() {
				return 0;
			},
			sideChromeWidth() {
				return 0;
			},
			paintTop(out, context) {
				out.push(context.borderStyle, "=".repeat(context.width));
				out.br();
				return true;
			},
			paintRow(out, context) {
				if (context.gutterStyle) out.push(context.gutterStyle, context.gutter);
				else paintComposerText(out, context.gutter);
				paintComposerContent(out, context);
				paintComposerText(out, context.pad);
				out.br();
			},
			paintBottom() {
				return false;
			},
		};
		const dispose = installExtensionComposerShape({
			label: "Extension Dock",
			description: "Custom extension composer",
			style,
		});
		try {
			expect(getComposerShapeOptions().at(-1)).toEqual({
				value: "extension-dock",
				label: "Extension Dock",
				description: "Custom extension composer",
			});
			const rendered = renderPreview("extension-dock", 76, previewStatus()).join("\n");
			expect(rendered).toContain("=".repeat(76));
			expect(rendered).toContain("EXT ");
			expect(rendered).toContain("Ask anything");
		} finally {
			dispose();
		}
		expect(getComposerShapeOptions().some(option => option.value === "extension-dock")).toBe(false);
	});
});
