import type { HostKeyEvent } from "../../host/input";
import { ComposerShapePreviewView } from "../../overlays/composer-shape-preview";
import type { ComposerShape } from "../../overlays/composer-shape-registry";
import { getComposerShapeOptions } from "../../overlays/composer-shape-registry";
import { createSelectController } from "../../overlays/select-overlay";
import { createSignal, onMount, Show, useFocus, type Accessor, type JSX } from "../../reactive";
import type { SetupScene, SetupSceneContext } from "./types";

/** Narrow setup contract for mounting and testing the composer scene directly. */
export interface ComposerSceneContext {
	readonly host: Pick<SetupSceneContext["host"], "composerShape" | "saveComposerShape" | "statusLine">;
	complete(result: "done" | "skipped"): void;
	/** Exact post-chrome scene body budget supplied by the setup wizard. */
	readonly availableRows?: Accessor<number>;
}

/** Intro, preview, and selection need this fixed post-chrome body budget. */
const PREVIEW_MIN_ROWS = 13;

export function ComposerSceneView(context: ComposerSceneContext): JSX.Element {
	const choices = getComposerShapeOptions();
	const options = choices.map((choice, index) => ({
		value: choice.value,
		label: `${index + 1}  ${choice.label}`,
		description: choice.description,
	}));
	const configuredShape = choices.some(choice => choice.value === context.host.composerShape)
		? context.host.composerShape
		: "band";
	const [saving, setSaving] = createSignal(false);
	const focus = useFocus();
	const availableRows = context.availableRows;
	const showPreview = (): boolean => availableRows === undefined || availableRows() >= PREVIEW_MIN_ROWS;
	const save = async (shape: ComposerShape): Promise<void> => {
		if (saving()) return;
		setSaving(true);
		try {
			await context.host.saveComposerShape(shape);
		} finally {
			context.complete("done");
		}
	};
	const selection = createSelectController({
		options: () => options,
		maxRows: () => options.length,
		selectedValue: configuredShape,
		search: "never",
		onSelect: save,
		onCancel: () => context.complete("skipped"),
	});
	onMount(() => focus.focus());
	const handleKey = (event: HostKeyEvent): void => {
		if (saving()) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const quickIndex = event.data.length === 1 ? Number(event.data) - 1 : -1;
		if (Number.isInteger(quickIndex) && quickIndex >= 0 && quickIndex < options.length) {
			selection.selectIndex(quickIndex);
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		selection.handleKey(event);
	};
	return (
		<box
			tabIndex={focus.tabIndex}
			onKey={handleKey}
			onMouse={event => {
				if (event.action === "wheel") selection.handleMouse(event, 0);
			}}
		>
			<stack gap={1}>
				<text color="muted">Select a layout; live preview updates below. Press Enter to confirm.</text>
				<Show when={showPreview()}>
					<Show when={choices[selection.selectedIndex()]?.value ?? choices[0]!.value} keyed>
						{(shape: ComposerShape) => (
							<ComposerShapePreviewView shape={shape} status={context.host.statusLine} />
						)}
					</Show>
				</Show>
				<box onMouse={event => selection.handleMouse(event, event.localRow)}>
					<select
						options={selection.options()}
						selectedIndex={selection.selectedIndex()}
						hoveredIndex={selection.hoveredIndex()}
						offset={selection.offset()}
						maxRows={selection.maxRows()}
					/>
				</box>
			</stack>
		</box>
	);
}

/** Select and persist the prompt composer layout. */
export const composerSetupScene: SetupScene = {
	id: "composer-shape",
	title: "Choose composer shape",
	subtitle: "Pick the prompt and status line layout for your workflow.",
	minVersion: 2,
	View: ComposerSceneView,
};
