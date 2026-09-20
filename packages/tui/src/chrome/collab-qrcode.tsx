import type { QrMatrix } from "../host/elements/qr";
import { urlHyperlinkAlwaysStyle } from "../render/hyperlink";
import { Show, type Accessor, type JSX, useTheme, useViewport } from "../reactive";

const QR_MARGIN = 4;

/** Scheme-less display form for a collaboration browser link. */
export function collabBrowserLink(webLink: string, label?: string): string {
	return label ?? webLink.replace(/^https?:\/\//, "");
}

/** QR dimensions including its scanner-required quiet zone and leading transcript gutter. */
export interface CollabQrDimensions {
	readonly columns: number;
	readonly rows: number;
}

export function collabQrDimensions(qr: QrMatrix): CollabQrDimensions {
	const modules = qr.size + QR_MARGIN * 2;
	return {
		columns: modules + 1,
		rows: Math.ceil(modules / 2),
	};
}

export interface CollabBrowserLinkViewProps {
	readonly url: string;
	readonly label?: string;
}

/** Accent-underlined browser link used by the invite status and constrained QR fallback. */
export function CollabBrowserLinkView(props: CollabBrowserLinkViewProps): JSX.Element {
	const style = urlHyperlinkAlwaysStyle(props.url);
	const display = style.link === 0 ? collabBrowserLink(props.url) : collabBrowserLink(props.url, props.label);
	return (
		<span style={style} color="accent" underline>
			{display}
		</span>
	);
}

export interface CollabInviteStatusViewProps {
	readonly url: string;
	readonly terminalLink: string;
	readonly heading: string;
	readonly appName: string;
	readonly access: "control" | "view";
}

/** Full browser and terminal join instructions shown before the one-shot QR symbol. */
export function CollabInviteStatusView(props: CollabInviteStatusViewProps): JSX.Element {
	const { theme } = useTheme();
	const watching = props.access === "view";
	return (
		<stack>
			<text color="text">
				<CollabBrowserLinkView url={props.url} label="Join in browser" />
				{"  "}
				<span color="success">{props.heading}</span>
			</text>
			<text color="text">
				{" "}
				<span color="accent">{theme().format.bullet}</span>{" "}
				<span color="muted">{watching ? "Watch from another terminal:" : "Join from another terminal:"}</span>
				{` ${props.appName} join "${props.terminalLink}"`}
			</text>
			<text color="text">
				{" "}
				<span color="accent">{theme().format.bullet}</span> <span color="muted">or any web browser:</span>{" "}
				<CollabBrowserLinkView url={props.url} />
			</text>
			<text color="dim">
				{watching
					? "Anyone with this link can watch the session but cannot prompt the agent."
					: "Anyone with the link can read the session and prompt the agent. Read-only link: /collab view"}
			</text>
		</stack>
	);
}

export type CollabQrAllocation = number | Accessor<number>;

export interface CollabQrCodeProps {
	readonly url: string;
	readonly qr: QrMatrix;
	/**
	 * Live transcript rows granted to this symbol. Omit while the transcript has
	 * not constrained the block; a finite allocation below the complete symbol
	 * switches to the one-row hint rather than exposing a quiet-zone fragment.
	 */
	readonly allocatedRows?: CollabQrAllocation;
}

function normalizedAllocation(value: CollabQrAllocation | undefined): number {
	const rows = typeof value === "function" ? value() : value;
	if (rows === undefined || !Number.isFinite(rows)) return Number.POSITIVE_INFINITY;
	return Math.max(0, Math.trunc(rows));
}

function hiddenReason(width: number, dimensions: CollabQrDimensions, allocatedRows: number): string | undefined {
	if (width < dimensions.columns) return `terminal width ${width}; need ${dimensions.columns}`;
	if (allocatedRows < dimensions.rows) return `viewport height ${allocatedRows}; need ${dimensions.rows}`;
	return undefined;
}

function CollabQrHiddenHint(props: { readonly url: string; readonly reason: string }): JSX.Element {
	return (
		<text wrap="none" overflow="clip">
			<CollabBrowserLinkView url={props.url} label="Join" />{" "}
			<span color="warning">{`QR code hidden: ${props.reason}.`}</span>
		</text>
	);
}

function CollabQrAtWidth(props: {
	readonly url: string;
	readonly qr: QrMatrix;
	readonly width: number;
	readonly allocatedRows?: CollabQrAllocation;
}): JSX.Element {
	const dimensions = collabQrDimensions(props.qr);
	const reason = () => hiddenReason(props.width, dimensions, normalizedAllocation(props.allocatedRows));
	return (
		<Show
			when={reason() === undefined}
			fallback={<CollabQrHiddenHint url={props.url} reason={reason() ?? "insufficient space"} />}
		>
			<row pad={false}>
				<box width={dimensions.columns} padding={{ left: 1 }}>
					<qr qr={props.qr} margin={QR_MARGIN} />
				</box>
			</row>
		</Show>
	);
}

/** Camera-readable collaboration link, or a concise space-constrained fallback. */
export function CollabQrCodeView(props: CollabQrCodeProps): JSX.Element {
	const viewport = useViewport();
	return (
		<sized
			paint={width => (
				<CollabQrAtWidth
					url={props.url}
					qr={props.qr}
					allocatedRows={props.allocatedRows}
					width={Math.min(width, viewport().columns)}
				/>
			)}
		/>
	);
}
