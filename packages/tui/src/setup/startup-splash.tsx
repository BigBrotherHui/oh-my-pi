import { mountOverlay, Portal } from "../host/overlay";
import { createSignal, onCleanup, onMount, useFocus, useViewport, type JSX } from "../reactive";
import type { TUI } from "../tui";
import type { SetupUiHost } from "./scenes/types";
import { setupSplashRows, SplashFrameView, SETUP_SPLASH_MS, SETUP_TICK_MS, type SplashRows } from "./scenes/splash";

/** Timing controls for the standalone startup animation. */
export interface RunStartupSplashOptions {
	readonly durationMs?: number;
	readonly tickMs?: number;
	readonly now?: () => number;
}

export interface StartupSplashViewProps {
	readonly rows: SplashRows;
}

/** The live TUI that owns the fullscreen splash overlay. */
export interface StartupSplashHost extends SetupUiHost {
	readonly ui: TUI;
}

/** Static splash frame for test rendering and embedding. */
export function StartupSplashView(props: StartupSplashViewProps): JSX.Element {
	return <SplashFrameView rows={props.rows} />;
}

/** Reactive fullscreen startup splash mounted over the interactive TUI. */
export function StartupSplash(props: {
	readonly host: SetupUiHost;
	readonly durationMs: number;
	readonly tickMs: number;
	readonly now: () => number;
	onComplete(): void;
}): JSX.Element {
	const viewport = useViewport();
	const focus = useFocus();
	const [frame, setFrame] = createSignal(0, { equals: false });
	let startedAt = 0;
	let timer: NodeJS.Timeout | undefined;
	let completed = false;

	const stopTimer = (): void => {
		if (timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
	};
	const complete = (): void => {
		if (completed) return;
		completed = true;
		stopTimer();
		props.onComplete();
	};
	const elapsed = (): number => {
		frame();
		return Math.min(props.durationMs, Math.max(0, props.now() - startedAt));
	};

	onMount(() => {
		startedAt = props.now();
		focus.focus();
		timer = setInterval(() => {
			if (props.now() - startedAt >= props.durationMs) {
				complete();
				return;
			}
			setFrame(value => value + 1);
		}, props.tickMs);
	});
	onCleanup(stopTimer);

	return (
		<Portal to="overlay" anchor="top-left" width="100%" maxHeight="100%" margin={0} fullscreen>
			<sized
				paint={width => (
					<box
						tabIndex={focus.tabIndex}
						onKey={event => {
							if (
								event.key === "enter" ||
								event.key === "return" ||
								event.key === "space" ||
								event.key === "escape" ||
								event.key === "esc"
							)
								complete();
						}}
					>
						<SplashFrameView rows={setupSplashRows(width, viewport().rows, elapsed())} />
					</box>
				)}
			/>
		</Portal>
	);
}

/** Mount the startup splash over the active TUI and dispose it when complete. */
export async function runStartupSplash(host: StartupSplashHost, options: RunStartupSplashOptions = {}): Promise<void> {
	const durationMs = options.durationMs ?? SETUP_SPLASH_MS;
	const tickMs = options.tickMs ?? SETUP_TICK_MS;
	if (!(tickMs > 0) || !Number.isFinite(tickMs)) throw new RangeError("frameMs must be a positive finite number");
	const now = options.now ?? Date.now;
	const completed = Promise.withResolvers<void>();
	let done = false;
	const finish = (): void => {
		if (done) return;
		done = true;
		completed.resolve();
	};
	const overlay = mountOverlay(host.ui, () => (
		<StartupSplash host={host} durationMs={durationMs} tickMs={tickMs} now={now} onComplete={finish} />
	));
	try {
		await completed.promise;
	} finally {
		overlay.dispose();
	}
}
