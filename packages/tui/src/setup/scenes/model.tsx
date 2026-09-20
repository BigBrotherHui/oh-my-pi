import type { Model } from "@oh-my-pi/pi-ai";
import { BROWSER_FRAME_ROWS } from "../../overlays/model-picker";
import {
	buildBrowserItems,
	ModelBrowserView,
	resolveRoleAssignments,
	sortModelItems,
	type ModelBrowserItem,
	type RoleAssignments,
} from "../../overlays/model-browser";
import { createMemo, createSignal, onCleanup, onMount, useViewport, type Accessor, type JSX } from "../../reactive";
import { wrapTextWithAnsi } from "../../utils";
import type { SetupHost, SetupScene, SetupSceneResult } from "./types";

const MAX_VISIBLE_MODELS = 10;
/** Header, footer, and margin rows in the historical fullscreen wizard. */
const LEGACY_WIZARD_CHROME_ROWS = 14;
/** WizardStep's blank row between the status introduction and browser. */
const STATUS_GAP_ROWS = 1;
const DEFAULT_STATUS = "Type to search. Enter saves the highlighted model as your default.";

export interface ModelSceneContext {
	readonly host: Pick<SetupHost, "getModels" | "modelSource" | "refreshModels" | "selectModel">;
	complete(result: SetupSceneResult): void;
	/** Exact rows the wizard has made available to this scene after its own chrome. */
	readonly availableRows?: Accessor<number>;
}

interface ModelSceneScope {
	readonly items: readonly ModelBrowserItem[];
	readonly roles: RoleAssignments;
	readonly currentSelector: string | undefined;
}

function modelSceneScope(host: ModelSceneContext["host"]): ModelSceneScope {
	const { available, all, current } = host.getModels();
	const roles = resolveRoleAssignments(host.modelSource, all, available);
	const items = buildBrowserItems(available);
	sortModelItems(items, { roles, mruOrder: host.modelSource.mruOrder });
	return {
		items,
		roles,
		currentSelector: current ? `${current.provider}/${current.id}` : undefined,
	};
}

function ModelSceneView(context: ModelSceneContext): JSX.Element {
	const viewport = useViewport();
	const [scope, setScope] = createSignal(modelSceneScope(context.host));
	const [status, setStatus] = createSignal<string | undefined>("Discovering available models…");
	const [statusColor, setStatusColor] = createSignal<"muted" | "error">("muted");
	const [saving, setSaving] = createSignal(false);
	const maxVisible = createMemo(() => {
		const availableRows = context.availableRows?.() ?? Math.max(0, viewport().rows - LEGACY_WIZARD_CHROME_ROWS);
		const contentWidth = Math.max(20, viewport().columns - 8);
		const statusRows = Math.max(1, wrapTextWithAnsi(status() ?? DEFAULT_STATUS, contentWidth).length);
		return Math.max(
			1,
			Math.min(MAX_VISIBLE_MODELS, availableRows - statusRows - STATUS_GAP_ROWS - BROWSER_FRAME_ROWS),
		);
	});
	let disposed = false;
	let completed = false;
	const complete = (result: SetupSceneResult): void => {
		if (disposed || completed) return;
		completed = true;
		context.complete(result);
	};

	onCleanup(() => {
		disposed = true;
	});
	onMount(() => {
		void (async () => {
			try {
				await context.host.refreshModels();
				if (disposed || completed) return;
				setScope(modelSceneScope(context.host));
				setStatus(undefined);
			} catch (error) {
				if (disposed) return;
				setStatus(error instanceof Error ? error.message : String(error));
				setStatusColor("error");
			}
		})();
	});

	const select = async (model: Model, selector: string): Promise<void> => {
		if (saving()) return;
		setSaving(true);
		setStatusColor("muted");
		setStatus(`Saving ${selector} as the default model…`);
		try {
			await context.host.selectModel(model, selector);
			complete("done");
		} catch (error) {
			if (disposed) return;
			setStatus(error instanceof Error ? error.message : String(error));
			setStatusColor("error");
			setSaving(false);
		}
	};

	return (
		<stack gap={1}>
			<text color={statusColor()}>{status() ?? DEFAULT_STATUS}</text>
			<sized
				paint={width => (
					<ModelBrowserView
						items={scope().items}
						roles={scope().roles}
						mruOrder={context.host.modelSource.mruOrder}
						providerOrder={context.host.modelSource.modelProviderOrder}
						perf={context.host.modelSource.modelPerf}
						roleInfo={context.host.modelSource.getRoleInfo}
						selectedSelector={scope().currentSelector}
						maxVisible={maxVisible()}
						width={width}
						onKey={saving}
						onSelect={item => void select(item.model, item.selector)}
						onCancel={() => complete("skipped")}
					/>
				)}
			/>
		</stack>
	);
}

/** Setup step that assigns one available model to the persisted default role. */
export const modelSetupScene: SetupScene = {
	id: "model",
	title: "Choose your default model",
	subtitle: "Search configured models and save the model used for new sessions.",
	minVersion: 1,
	View: ModelSceneView,
};

export { ModelSceneView };
