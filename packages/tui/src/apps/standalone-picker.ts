import { ProcessTerminal } from "../terminal";
import { render } from "../root";
import { theme } from "../theme/theme";
import type { JSX } from "../reactive";
import { StandaloneInputView, StandaloneSelectView } from "./standalone-picker-view";

/** Build context for a standalone reactive prompt. */
export interface StandaloneTuiContext<T> {
	/** Idempotently resolves the prompt and disposes its root. */
	finish(value: T): void;
}

/** A single selectable standalone item. */
export interface StandaloneSelectItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	readonly disabled?: boolean;
}

/** Retained for call-site compatibility; standalone prompts always own their root. */
export interface StandaloneTuiOptions {
	readonly fullscreen?: boolean;
}

/** Run a one-shot reactive TUI until the view calls `finish`. */
export async function runStandaloneTui<T>(
	build: (context: StandaloneTuiContext<T>) => JSX.Element,
	_options: StandaloneTuiOptions = {},
): Promise<T> {
	const completed = Promise.withResolvers<T>();
	let settled = false;
	const finish = (value: T): void => {
		if (settled) return;
		settled = true;
		completed.resolve(value);
	};
	const root = render(() => build({ finish }), { terminal: new ProcessTerminal(), theme });
	try {
		return await completed.promise;
	} finally {
		root.dispose();
	}
}

/** Options for a standalone single-column item picker. */
export interface StandaloneSelectOptions {
	readonly currentValue?: string;
	readonly maxVisible?: number;
}

/** Show a single-column item picker and resolve with the chosen value. */
export function selectStandaloneItem(
	title: string,
	items: readonly StandaloneSelectItem[],
	options: StandaloneSelectOptions = {},
): Promise<string | null> {
	process.stdout.write(`${title}\n`);
	return runStandaloneTui(context => StandaloneSelectView({ items, options, onFinish: context.finish }));
}

/** Show a one-shot text prompt and resolve with trimmed input or null. */
export function promptStandaloneText(title: string): Promise<string | null> {
	process.stdout.write(`${title}\n`);
	return runStandaloneTui(context => StandaloneInputView({ onFinish: context.finish }));
}
