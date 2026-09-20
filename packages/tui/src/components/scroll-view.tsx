/** Compatibility-free scroll geometry surface retained for host elements. */
export type { ScrollProps, ScrollViewportState } from "../host/elements/scroll";
export {
	centeredViewportRange,
	clampScrollOffset,
	cursorColumnWindow,
	maxScrollOffset,
	scrollbarThumbRange,
	scrollOffsetForRow,
	viewportOverflows,
	viewportRange,
	type CursorColumnWindow,
	type ScrollbarThumbRange,
	type ViewportAlignment,
	type ViewportRange,
} from "./scroll-viewport";
