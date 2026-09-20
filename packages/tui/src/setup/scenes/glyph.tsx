import { setSymbolPreset, type SymbolPreset } from "../../theme/theme";
import { createSelectController } from "../../overlays/select-overlay";
import { createSignal, onCleanup, onMount, useFocus, type JSX } from "../../reactive";
import type { HostKeyEvent, HostMouseEvent } from "../../host/input";
import type { SetupScene, SetupSceneContext, SetupSceneResult } from "./types";

const GLYPH_PRESETS = ["nerd", "unicode", "ascii"] as const satisfies readonly SymbolPreset[];
const GLYPH_LABELS: Readonly<Record<SymbolPreset, string>> = {
	nerd: "Nerd Font",
	unicode: "Unicode",
	ascii: "ASCII",
};
const GLYPH_SAMPLES: Readonly<Record<SymbolPreset, string>> = {
	nerd: "      󰉋  ",
	unicode: "✔  ✖  📁  ⬢  ╭─╮  ├─  •  ⠋  →",
	ascii: "[ok]  [x]  >  +  [D]  +-+  |--  *  ->",
};

/** One picker row per preset; the description column shows live sample glyphs instead of prose. */
const GLYPH_OPTIONS = GLYPH_PRESETS.map((preset, index) => ({
	value: preset,
	label: `${index + 1}  ${GLYPH_LABELS[preset]}`,
	description: preset === "nerd" ? `${GLYPH_SAMPLES.nerd}  ╭─╮  ├─  ◆  ✔  ✖` : GLYPH_SAMPLES[preset],
}));

const SELECT_ROW_START = 2;

function glyphPreset(value: string): SymbolPreset | undefined {
	if (value === "nerd" || value === "unicode" || value === "ascii") return value;
	return undefined;
}

function consume(event: HostKeyEvent | HostMouseEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function GlyphSceneView(context: SetupSceneContext): JSX.Element {
	const [saving, setSaving] = createSignal(false);
	const focus = useFocus();
	let active = true;
	let finished = false;
	const complete = (result: SetupSceneResult): void => {
		if (!active || finished) return;
		finished = true;
		context.complete(result);
	};
	onCleanup(() => {
		active = false;
	});
	const preview = (preset: SymbolPreset): void => {
		void setSymbolPreset(preset);
	};
	const save = async (preset: SymbolPreset): Promise<void> => {
		if (saving() || finished) return;
		setSaving(true);
		try {
			context.host.saveSymbolPreset(preset);
			await setSymbolPreset(preset);
			complete("done");
		} finally {
			if (active && !finished) setSaving(false);
		}
	};
	const select = createSelectController({
		options: () => GLYPH_OPTIONS,
		maxRows: () => GLYPH_OPTIONS.length,
		selectedValue: context.host.symbolPreset,
		search: "never",
		onChange: value => {
			const preset = glyphPreset(value);
			if (preset) preview(preset);
		},
		onSelect: value => {
			const preset = glyphPreset(value);
			if (preset) void save(preset);
		},
		onCancel: () => complete("skipped"),
	});
	const handleKey = (event: HostKeyEvent): void => {
		if (saving() || finished) {
			consume(event);
			return;
		}
		const quickIndex = event.data >= "1" && event.data <= "3" ? Number(event.data) - 1 : -1;
		if (quickIndex < 0) {
			select.handleKey(event);
			return;
		}
		const preset = GLYPH_PRESETS[quickIndex];
		if (!preset) return;
		if (!select.selectIndex(quickIndex)) preview(preset);
		consume(event);
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (saving() || finished) {
			consume(event);
			return;
		}
		select.handleMouse(event, event.localRow - SELECT_ROW_START);
	};

	onMount(() => focus.focus());

	return (
		<box tabIndex={focus.tabIndex} onKey={handleKey} onMouse={handleMouse}>
			<stack gap={1}>
				<text color="muted">If a row shows boxes, tofu, or misaligned icons, pick another.</text>
				<select
					options={select.options()}
					selectedIndex={select.selectedIndex()}
					hoveredIndex={select.hoveredIndex()}
					offset={select.offset()}
					maxRows={select.maxRows()}
				/>
			</stack>
		</box>
	);
}

/** Preview and persist the terminal glyph preset. */
export const glyphSetupScene: SetupScene = {
	id: "glyph-mode",
	title: "Choose glyph mode",
	subtitle: "Pick the row that renders cleanly in your terminal.",
	minVersion: 1,
	View: GlyphSceneView,
};
