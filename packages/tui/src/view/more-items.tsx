import { pluralize } from "@oh-my-pi/pi-utils";
import type { JSX } from "../reactive";

/** Props for a hidden-item summary. */
export interface MoreItemsProps {
	readonly remaining: number;
	readonly itemType: string;
}

/** Format a finite hidden-item count. */
export function moreItemsText(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? Math.max(0, Math.trunc(remaining)) : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

/** Render a muted hidden-item summary. */
export function MoreItems(props: MoreItemsProps): JSX.Element {
	return <span color="muted">{moreItemsText(props.remaining, props.itemType)}</span>;
}
