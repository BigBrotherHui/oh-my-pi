import type { JSX } from "../../src/reactive";
import { renderToRows } from "../../src/testing";

/** Paint one reactive view through the retained host test surface. */
export function renderVNode(view: JSX.Element): string {
	return renderToRows(() => view, 4096).join("\n");
}

export function renderSegmentContent(segment: { readonly content: JSX.Element }): string {
	return renderVNode(segment.content);
}
