import type { JSX } from "../reactive";
import type { Theme } from "../theme/theme";
import { renderNestedTaskResults, TaskRows, type TaskToolDetails } from "./task";

/** Display callbacks for structured data extracted from a child agent tool. */
export interface SubprocessToolRenderer<TData = unknown> {
	/** Render a single data item inline during streaming progress. */
	renderInline?: (data: TData, theme?: Theme) => JSX.Element;
	/** Render accumulated data in the final result view. */
	renderFinal?: (allData: TData[], theme?: Theme, expanded?: boolean) => JSX.Element;
}

const renderers = new Map<string, SubprocessToolRenderer>();

/** Renders nested task results extracted from child agents. */
export const taskSubprocessRenderer: SubprocessToolRenderer<TaskToolDetails> = {
	renderFinal(allData: TaskToolDetails[], theme?: Theme, expanded = false): JSX.Element {
		return <TaskRows rows={renderNestedTaskResults(allData, expanded, theme)} theme={theme} />;
	},
};

registerSubprocessToolRenderer("task", taskSubprocessRenderer);

/** Registers the display callbacks for a subprocess tool without its execution handler. */
export function registerSubprocessToolRenderer<T>(toolName: string, renderer: SubprocessToolRenderer<T>): void {
	renderers.set(toolName, renderer as SubprocessToolRenderer);
}

/** Looks up the display callbacks for a subprocess tool. */
export function getSubprocessToolRenderer(toolName: string): SubprocessToolRenderer | undefined {
	return renderers.get(toolName);
}
