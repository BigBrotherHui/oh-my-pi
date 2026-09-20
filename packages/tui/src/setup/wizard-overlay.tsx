import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Portal } from "../host/overlay";
import { PI_LOGO } from "../prompt/welcome";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	For,
	onMount,
	Show,
	useClock,
	useFocus,
	useViewport,
	type Accessor,
	type JSX,
} from "../reactive";
import {
	gradientLogoRows,
	setupSplashRows,
	SplashFrameView,
	SETUP_SPLASH_MS,
	SETUP_TICK_MS,
	type SplashCell,
} from "./scenes/splash";
import { setupOutroRows, SetupOutroView, SETUP_OUTRO_MS } from "./scenes/outro";
import type { SetupHost, SetupResult, SetupScene, SetupSceneContext, SetupSceneResult } from "./scenes/types";

type WizardPhase = "splash" | "transition" | "scene" | "outro" | "done";

const SCENE_MARGIN_X = 4;
const MIN_CONTENT_WIDTH = 20;
const SCENE_TRANSITION_MS = 420;

interface WizardSceneContext extends SetupSceneContext {
	readonly availableRows: Accessor<number>;
}

function CenteredSplashRow(props: { readonly cells: readonly SplashCell[] }): JSX.Element {
	return (
		<text align="center" wrap="none">
			{props.cells.map((cell, index) => (
				<span key={index} style={cell.style}>
					{cell.text}
				</span>
			))}
		</text>
	);
}

/** The historical scene header, bounded body slot, and bottom-aligned footer. */
function SetupSceneFrameView(props: {
	readonly scene: Accessor<SetupScene | undefined>;
	readonly sceneIndex: Accessor<number>;
	readonly sceneCount: number;
	readonly context: WizardSceneContext;
}): JSX.Element {
	const viewport = useViewport();
	const logo = gradientLogoRows(PI_LOGO, 0, { pos: 0, strength: 0 });
	const sceneIndent = (): number => Math.min(SCENE_MARGIN_X, Math.max(0, viewport().columns - 1));
	const contentWidth = (): number => Math.max(MIN_CONTENT_WIDTH, viewport().columns - SCENE_MARGIN_X * 2);

	return (
		<scroll height={Math.max(0, viewport().rows)} scrollbar="never">
			<stack>
				<text>{""}</text>
				<For each={logo}>{row => <CenteredSplashRow cells={row} />}</For>
				<text align="center" wrap="clip" overflow="clip">
					<span color="accent" bold>
						{APP_NAME}
					</span>
				</text>
				<text align="center" color="muted" wrap="clip" overflow="clip">
					Setup step {props.sceneIndex() + 1} of {props.sceneCount}
				</text>
				<text>{""}</text>
				<box padding={{ left: sceneIndent() }}>
					<text bold wrap="clip" overflow="clip">
						{props.scene()?.title ?? "Setup"}
					</text>
				</box>
				<Show when={props.scene()?.subtitle}>
					{(subtitle: Accessor<string>) => (
						<box padding={{ left: sceneIndent() }}>
							<text color="muted" wrap="clip" overflow="clip">
								{subtitle()}
							</text>
						</box>
					)}
				</Show>
				<text>{""}</text>
				<box padding={{ left: sceneIndent() }}>
					<scroll height={props.context.availableRows()} contentWidth={contentWidth()} scrollbar="never">
						<Show when={props.scene()} keyed>
							{(scene: SetupScene) => scene.View(props.context)}
						</Show>
					</scroll>
				</box>
				<text>{""}</text>
				<text align="center" color="dim" wrap="clip" overflow="clip">
					↑/↓ select · enter confirm · esc skip · ctrl+c exit setup
				</text>
			</stack>
		</scroll>
	);
}

export interface SetupWizardViewProps {
	readonly host: SetupHost;
	readonly scenes: readonly SetupScene[];
	onComplete(result: SetupResult): void;
}

/** Number of leading rows transferred from splash to scene during the dissolve. */
function dissolveRevealRows(height: number, elapsedMs: number): number {
	const progress = Math.max(0, Math.min(1, elapsedMs / SCENE_TRANSITION_MS));
	const eased = progress * progress * (3 - 2 * progress);
	return Math.max(0, Math.min(Math.max(0, height), Math.round(height * eased)));
}

/** Reactive full-screen onboarding wizard surface. */
function SetupWizardSurface(props: SetupWizardViewProps): JSX.Element {
	const [phase, setPhase] = createSignal<WizardPhase>(props.scenes.length > 0 ? "splash" : "outro");
	const [sceneIndex, setSceneIndex] = createSignal(0);
	const [results, setResults] = createSignal<readonly { readonly id: string; readonly result: SetupSceneResult }[]>(
		[],
	);
	const [outcome, setOutcome] = createSignal<SetupResult["status"]>("completed");
	const [phaseStartedAt, setPhaseStartedAt] = createSignal(0);
	const clock = useClock("frame");
	const focus = useFocus();
	const viewport = useViewport();
	const current = createMemo<SetupScene | undefined>(() => props.scenes[sceneIndex()]);
	const availableRows = (): number => {
		const scene = current();
		return Math.max(0, viewport().rows - PI_LOGO.length - 8 - (scene?.subtitle ? 1 : 0));
	};

	onMount(() => {
		setPhaseStartedAt(clock());
		focus.focus();
	});

	const elapsed = (): number => Math.max(0, clock() - phaseStartedAt());
	const finish = (): void => {
		if (phase() === "done") return;
		setPhase("done");
		props.onComplete({ status: outcome(), scenes: results() });
	};
	const beginOutro = (status: SetupResult["status"]): void => {
		if (phase() === "done") return;
		batch(() => {
			setOutcome(status);
			setPhase("outro");
			setPhaseStartedAt(clock());
		});
	};
	const beginScene = (): void => {
		if (props.scenes.length === 0) {
			beginOutro("completed");
			return;
		}
		batch(() => {
			setPhase("transition");
			setPhaseStartedAt(clock());
		});
	};
	const finishScene = (result: SetupSceneResult): void => {
		if (phase() !== "scene" && phase() !== "transition") return;
		const scene = current();
		if (!scene) return;
		const nextIndex = sceneIndex() + 1;
		setResults(previous => [...previous, { id: scene.id, result }]);
		if (nextIndex >= props.scenes.length) {
			setSceneIndex(nextIndex);
			beginOutro("completed");
			return;
		}
		batch(() => {
			setSceneIndex(nextIndex);
			setPhase("scene");
			setPhaseStartedAt(clock());
		});
	};
	const context: WizardSceneContext = { host: props.host, complete: finishScene, availableRows };
	const dissolvedRows = (): number => dissolveRevealRows(viewport().rows, elapsed());

	createEffect(() => {
		const active = phase();
		const age = elapsed();
		if (active === "splash" && age >= SETUP_SPLASH_MS) beginScene();
		else if (active === "transition" && age >= SCENE_TRANSITION_MS) {
			batch(() => {
				setPhase("scene");
				setPhaseStartedAt(clock());
			});
		} else if (active === "outro" && age >= SETUP_OUTRO_MS) finish();
	});

	return (
		<box
			tabIndex={focus.tabIndex}
			onKey={event => {
				if (event.key === "ctrl+c") {
					beginOutro("cancelled");
					event.preventDefault();
					event.stopPropagation();
				} else if (
					phase() === "splash" &&
					(event.key === "enter" || event.key === "return" || event.key === "space" || event.key === "escape")
				) {
					beginScene();
					event.preventDefault();
				} else if (
					phase() === "outro" &&
					(event.key === "enter" || event.key === "return" || event.key === "space" || event.key === "escape")
				) {
					finish();
					event.preventDefault();
				}
			}}
			onMouse={event => {
				if (event.action !== "down" || event.button !== 0) return;
				if (phase() === "splash") beginScene();
				else if (phase() === "outro") finish();
			}}
		>
			<Show when={phase() === "splash"}>
				<SplashFrameView rows={setupSplashRows(viewport().columns, viewport().rows, elapsed())} />
			</Show>
			<Show when={phase() === "transition"}>
				<stack gap={0}>
					<scroll height={dissolvedRows()} scrollbar="never">
						<SetupSceneFrameView
							scene={current}
							sceneIndex={sceneIndex}
							sceneCount={props.scenes.length}
							context={context}
						/>
					</scroll>
					<scroll
						height={Math.max(0, viewport().rows - dissolvedRows())}
						offset={dissolvedRows()}
						scrollbar="never"
					>
						<SplashFrameView
							rows={setupSplashRows(viewport().columns, viewport().rows, SETUP_SPLASH_MS + elapsed())}
						/>
					</scroll>
				</stack>
			</Show>
			<Show when={phase() === "scene"}>
				<SetupSceneFrameView
					scene={current}
					sceneIndex={sceneIndex}
					sceneCount={props.scenes.length}
					context={context}
				/>
			</Show>
			<Show when={phase() === "outro"}>
				<SetupOutroView rows={setupOutroRows(viewport().columns, viewport().rows, elapsed())} />
			</Show>
		</box>
	);
}

/** Fullscreen modal portal that keeps setup inside the existing retained root. */
export function SetupWizard(props: SetupWizardViewProps): JSX.Element {
	return (
		<Portal to="overlay" fullscreen modal mouseTracking>
			<SetupWizardSurface {...props} />
		</Portal>
	);
}

/** Kept as a named surface export for tests and embedding. */
export const SetupWizardView = SetupWizardSurface;

export { SETUP_TICK_MS };
