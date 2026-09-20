import {
	AutoresearchDashboardView,
	AutoresearchDashboardWidgetView,
	shouldShowAutoresearchDashboard,
	type AutoresearchDashboardRuntime,
} from "@oh-my-pi/pi-tui/apps/autoresearch-dashboard";
import { createOverlayDisposer, mountOverlay, Portal, type OverlayDisposer } from "@oh-my-pi/pi-tui/overlay";
import { createSignal, type Accessor } from "@oh-my-pi/pi-tui/reactive";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ExtensionContext } from "../extensibility/extensions";
import type { AutoresearchRuntime } from "./types";

const WIDGET_KEY = "autoresearch";

function dashboardRuntime(runtime: AutoresearchRuntime, dashboardExpanded: boolean): AutoresearchDashboardRuntime {
	return {
		autoresearchMode: runtime.autoresearchMode,
		dashboardExpanded,
		state: runtime.state,
		lastRunSummary:
			runtime.lastRunSummary === null
				? null
				: {
						runNumber: runtime.lastRunSummary.runNumber,
						passed: runtime.lastRunSummary.passed,
						parsedPrimary: runtime.lastRunSummary.parsedPrimary,
					},
		runningExperiment:
			runtime.runningExperiment === null
				? null
				: {
						startedAt: runtime.runningExperiment.startedAt,
						command: runtime.runningExperiment.command,
					},
	};
}

export interface AutoresearchDashboardStore {
	readonly runtime: Accessor<AutoresearchDashboardRuntime>;
	publish(runtime: AutoresearchRuntime): void;
	toggleWidget(ctx: ExtensionContext, runtime: AutoresearchRuntime): void;
	updateWidget(ctx: ExtensionContext, runtime: AutoresearchRuntime): void;
	clear(ctx: ExtensionContext): void;
	open(tui: TUI, onClose: () => void): OverlayDisposer;
}

export function createAutoresearchDashboardStore(initial: AutoresearchRuntime): AutoresearchDashboardStore {
	let expanded = false;
	const [runtime, setRuntime] = createSignal(dashboardRuntime(initial, expanded));
	let activeOverlay: OverlayDisposer | undefined;
	let closeActiveOverlay: (() => void) | undefined;
	const publish = (next: AutoresearchRuntime): AutoresearchDashboardRuntime => {
		const snapshot = dashboardRuntime(next, expanded);
		setRuntime(snapshot);
		return snapshot;
	};
	const updateWidget = (ctx: ExtensionContext, next: AutoresearchRuntime): void => {
		const snapshot = publish(next);
		if (!shouldShowAutoresearchDashboard(snapshot)) closeActiveOverlay?.();
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			shouldShowAutoresearchDashboard(snapshot)
				? () => <AutoresearchDashboardWidgetView runtime={runtime} />
				: undefined,
		);
	};

	return {
		runtime,
		publish,
		toggleWidget(ctx, next) {
			expanded = !expanded;
			updateWidget(ctx, next);
		},
		updateWidget,
		clear(ctx) {
			closeActiveOverlay?.();
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		},
		open(tui, onClose) {
			closeActiveOverlay?.();
			const disposer = createOverlayDisposer(() => {
				if (activeOverlay === disposer) {
					activeOverlay = undefined;
					closeActiveOverlay = undefined;
				}
				overlay?.dispose();
			});
			const close = (): void => {
				if (!disposer || activeOverlay !== disposer) return;
				disposer.dispose();
				onClose();
			};
			const overlay = mountOverlay(tui, () => (
				<Portal to="overlay" fullscreen>
					<AutoresearchDashboardView runtime={runtime} onClose={close} />
				</Portal>
			));
			activeOverlay = disposer;
			closeActiveOverlay = close;
			return disposer;
		},
	};
}
