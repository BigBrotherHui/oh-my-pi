import { emitRows, RichText } from "@oh-my-pi/pi-tui";
import { StatusLine, type StatusLineLayout, type StatusLineSource } from "@oh-my-pi/pi-tui/status-line";
import type { JSX } from "@oh-my-pi/pi-tui/reactive";
import { mountForTest } from "@oh-my-pi/pi-tui/testing";

interface DisposableStatusLine {
	dispose(): void;
}

type StatusOutput = string | RichText | JSX.Element;

/** Render status output and emit its terminal representation for style-sensitive assertions. */
export function renderStatus(output: StatusOutput, width = 1000): string {
	if (typeof output === "string") return output;
	if (output instanceof RichText) return emitRows(output, { mode: "truecolor" }).join("\n");
	const testRoot = mountForTest(() => output, { width });
	try {
		return testRoot.rows(width).join("\n");
	} finally {
		testRoot.dispose();
	}
}

/** Render a declarative status layout through the retained test host. */
export function renderStatusLine(
	source: StatusLineSource,
	width: number,
	layout: StatusLineLayout = "box",
	previewTitle?: string,
	placeholders?: boolean,
): string {
	const root = mountForTest(() => StatusLine({ source, layout, previewTitle, placeholders }), { width });
	try {
		return root.rows(width).join("\n");
	} finally {
		root.dispose();
	}
}

/** Owns status-line components created by one test file so teardown cannot leak asynchronous work. */
export class StatusLineTestComponents {
	#components: DisposableStatusLine[] = [];

	/** Tracks a component until this file's teardown. */
	track<T extends DisposableStatusLine>(component: T): T {
		this.#components.push(component);
		return component;
	}

	/** Disposes every tracked component before the file resets global settings. */
	dispose(): void {
		for (const component of this.#components.splice(0)) component.dispose();
	}
}
