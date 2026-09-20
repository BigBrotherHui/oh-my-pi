import type { JSX as SolidJSX } from "solid-js";
import type { RichText } from "../core/richtext";
import type { StyleProps } from "../style/types";
import type { CommonInputProps } from "./input";
import type { LayoutProps, HostElement } from "./types";
import type { BadgeProps } from "./elements/badge";
import type { BoxProps } from "./elements/box";
import type { BrProps } from "./elements/br";
import type { ChoiceProps } from "./elements/choice";
import type { CodeProps } from "./elements/code";
import type { CursorProps } from "./elements/cursor";
import type { DiffProps } from "./elements/diff";
import type { DurationProps } from "./elements/duration";
import type { EditorElementProps } from "./elements/editor";
import type { FrameProps } from "./elements/frame";
import type { HrProps } from "./elements/hr";
import type { IconProps } from "./elements/icon";
import type { ImageElementProps } from "./elements/image";
import type { InputElementProps } from "./elements/input";
import type { JsonProps } from "./elements/json";
import type { LinkProps } from "./elements/link";
import type { MarkdownProps } from "./elements/markdown";
import type { MetaProps } from "./elements/meta";
import type { PathProps } from "./elements/path";
import type { PreProps } from "./elements/pre";
import type { PreviewProps } from "./elements/preview";
import type { ProgressProps } from "./elements/progress";
import type { QrProps } from "./elements/qr";
import type { RailProps } from "./elements/rail";
import type { RawProps } from "./elements/raw";
import type { RowProps } from "./elements/row";
import type { ScrollProps } from "./elements/scroll";
import type { SelectProps } from "./elements/select";
import type { ShimmerProps } from "./elements/shimmer";
import type { SizedProps } from "./elements/sized";
import type { SpanProps } from "./elements/span";
import type { SpinnerProps } from "./elements/spinner";
import type { SplitProps } from "./elements/split";
import type { StackProps } from "./elements/stack";
import type { StatusProps } from "./elements/status";
import type { TableProps } from "./elements/table";
import type { TabsProps } from "./elements/tabs";
import type { TerminalElementProps } from "./elements/terminal";
import type { TextProps } from "./elements/text";
import type { TimestampProps } from "./elements/timestamp";
import type { TreeProps } from "./elements/tree";

/** Props accepted by every retained host element. */
export interface HostElementProps extends LayoutProps, StyleProps, CommonInputProps {
	readonly children?: SolidJSX.Element;
	readonly key?: string | number;
	readonly ref?: HostElement | ((element: HostElement) => void);
}

/** Props for the transcript's mutable retained tail. */
export interface TranscriptProps {
	readonly children?: SolidJSX.Element;
	/** Reset the semantic ledger when a session replaces its transcript. */
	readonly generation?: number;
}

/** Stable-row marker used by transcript block retirement. */
export interface StableTranscriptRow {
	readonly key: string;
}

/** Props for one mutable or append-only transcript block. */
export interface TranscriptBlockProps {
	readonly children?: SolidJSX.Element;
	/** Semantic compact projection, mounted only while viewport pressure requests it. */
	readonly compact?: SolidJSX.Element;
	/** Immutable semantic-prefix projection rendered offscreen by the transcript. */
	readonly stable?: SolidJSX.Element;
	/** Select the immutable semantic prefix rendered in the stable slot. */
	readonly onStableRender?: (count: number) => void;
	/** Reset producer publication alongside a destructive history reset. */
	readonly onResetStableRows?: () => void;
	/** Select compact projection ownership without changing the full history body. */
	readonly onCompact?: (compact: boolean) => void;
	/** Measured start row within the current uncommitted transcript layout. */
	readonly onRowLayout?: (row: number) => void;
	/** Maximum live output rows after surrounding chrome has been allocated. */
	readonly onAllocation?: (rows: number) => void;
	/** Lock removal when any part of the block enters a history transaction. */
	readonly onRetire?: () => void;
	/** Identify tools eligible for a compact view only while actively oversized. */
	readonly toolActivity?: boolean;
	readonly settled?: boolean;
	readonly mode?: "mutable" | "appendOnly";
	readonly stableRows?: readonly StableTranscriptRow[];
	readonly renderStableRows?: (count: number, width: number) => RichText;
}

export interface TuiIntrinsicElements {
	stack: HostElementProps & StackProps;
	row: HostElementProps & RowProps;
	box: HostElementProps & BoxProps;
	sized: HostElementProps & SizedProps;
	text: HostElementProps & TextProps;
	span: HostElementProps & SpanProps;
	br: HostElementProps & BrProps;
	cursor: HostElementProps & CursorProps;
	raw: HostElementProps & RawProps;
	rail: HostElementProps & RailProps;
	scroll: HostElementProps & ScrollProps;
	split: HostElementProps & SplitProps;
	hr: HostElementProps & HrProps;
	frame: HostElementProps & FrameProps;
	icon: HostElementProps & IconProps;
	status: HostElementProps & StatusProps;
	badge: HostElementProps & BadgeProps;
	meta: HostElementProps & MetaProps;
	path: HostElementProps & PathProps;
	link: HostElementProps & LinkProps;
	tree: HostElementProps & TreeProps;
	preview: HostElementProps & PreviewProps;
	code: HostElementProps & CodeProps;
	pre: HostElementProps & PreProps;
	diff: HostElementProps & DiffProps;
	markdown: HostElementProps & MarkdownProps;
	json: HostElementProps & JsonProps;
	table: HostElementProps & TableProps;
	progress: HostElementProps & ProgressProps;
	spinner: HostElementProps & SpinnerProps;
	shimmer: HostElementProps & ShimmerProps;
	duration: HostElementProps & DurationProps;
	timestamp: HostElementProps & TimestampProps;
	choice: HostElementProps & ChoiceProps;
	select: HostElementProps & SelectProps;
	tabs: HostElementProps & TabsProps;
	input: HostElementProps & InputElementProps;
	editor: HostElementProps & EditorElementProps;
	terminal: HostElementProps & TerminalElementProps;
	image: HostElementProps & ImageElementProps;
	qr: HostElementProps & QrProps;
	transcript: HostElementProps & TranscriptProps;
	"transcript-block": HostElementProps & TranscriptBlockProps;
}
