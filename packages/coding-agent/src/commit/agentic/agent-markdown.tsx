import { createDocument } from "@oh-my-pi/pi-tui/document/document";
import { renderToRows } from "@oh-my-pi/pi-tui/testing";

/** Render agent output with the retained markdown host for the process terminal. */
export function renderCommitMarkdown(markdown: string, width: number): readonly string[] {
	return renderToRows(() => <markdown document={createDocument(markdown)} />, width);
}
