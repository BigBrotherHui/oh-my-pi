import { CURRENT_SETUP_VERSION } from "./setup-version";
import { composerSetupScene } from "./scenes/composer";
import { glyphSetupScene } from "./scenes/glyph";
import { modelSetupScene } from "./scenes/model";
import { providersSetupScene } from "./scenes/providers";
import { themeSetupScene } from "./scenes/theme";
import type { SetupHost, SetupResult, SetupScene } from "./scenes/types";
import { mountOverlay } from "../host/overlay";
import { SetupWizard } from "./wizard-overlay";

export type {
	SetupHost,
	SetupResult,
	SetupScene,
	SetupSceneContext,
	SetupSceneResult,
	SetupUiHost,
} from "./scenes/types";
export { runStartupSplash } from "./startup-splash";
export { CURRENT_SETUP_VERSION };

/** Ordered onboarding scenes with independent version gates. */
export const ALL_SCENES = [
	providersSetupScene,
	modelSetupScene,
	glyphSetupScene,
	composerSetupScene,
	themeSetupScene,
] as const satisfies readonly SetupScene[];

/** Environment and invocation gates for onboarding scene selection. */
export interface SetupSceneSelectionOptions {
	resuming?: boolean;
	isTTY?: boolean;
	skipEnv?: string;
	setupWizardEnabled?: boolean;
	force?: boolean;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/** Select scenes newer than the stored version, honoring hard environment gates. */
export async function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	host?: SetupHost,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	const isTTY = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
	if (!isTTY) return [];
	if (!options.force) {
		if (options.resuming) return [];
		if (setupSkipEnvEnabled(options.skipEnv ?? Bun.env.OMP_SKIP_SETUP)) return [];
		if (options.setupWizardEnabled === false) return [];
	}
	const selected: SetupScene[] = [];
	for (const scene of scenes) {
		if (!options.force && scene.minVersion <= storedVersion) continue;
		if (scene.shouldRun) {
			if (!host || !(await scene.shouldRun(host))) continue;
		}
		selected.push(scene);
	}
	return selected;
}

/** Control completion persistence and the post-setup welcome animation. */
export interface RunSetupWizardOptions {
	markComplete?: boolean;
	playWelcomeIntro?: boolean;
}

/** Mount and own the fullscreen setup portal until its scenes and outro finish. */
export async function runSetupWizard(
	host: SetupHost,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<SetupResult> {
	if (scenes.length === 0) return { status: "completed", scenes: [] };
	const completed = Promise.withResolvers<SetupResult>();
	let settled = false;
	const overlay = mountOverlay(host.tui, () =>
		SetupWizard({
			host,
			scenes,
			onComplete(result): void {
				if (settled) return;
				settled = true;
				completed.resolve(result);
			},
		}),
	);
	let result: SetupResult;
	try {
		result = await completed.promise;
	} finally {
		overlay.dispose();
	}
	if (result.status === "completed" && options.markComplete !== false) await host.markComplete(CURRENT_SETUP_VERSION);
	if (result.status === "completed" && options.playWelcomeIntro !== false) host.playWelcomeIntro();
	return result;
}
