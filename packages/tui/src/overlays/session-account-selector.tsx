import { type JSX } from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { SelectOption } from "../host/elements/select";
import type { SizeValue, TUI } from "../tui";
import { SelectOverlay } from "./select-overlay";

const ACCOUNT_SELECTOR_MAX_VISIBLE = 10;

/** Stored account identity rendered and matched by the session account picker. */
export interface SessionPinAccount {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
	label: string;
}

export interface SessionAccountSelectorProps {
	readonly providerName: string;
	readonly accounts: readonly SessionPinAccount[];
	readonly onSelect: (account: SessionPinAccount) => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

export function SessionAccountSelector(props: SessionAccountSelectorProps): JSX.Element {
	const options: readonly SelectOption[] = props.accounts.map(account => ({
		value: String(account.credentialId),
		label: account.label,
		description: account.active ? "active for this session" : undefined,
	}));
	const maxRows = Math.min(Math.max(options.length, 1), ACCOUNT_SELECTOR_MAX_VISIBLE);
	const select = (value: string): void => {
		const account = props.accounts.find(candidate => String(candidate.credentialId) === value);
		if (account) props.onSelect(account);
	};
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<SelectOverlay
				title={`Select a ${props.providerName} account for this session`}
				options={options}
				selectedIndex={Math.max(
					0,
					props.accounts.findIndex(account => account.active),
				)}
				maxRows={maxRows}
				onSelect={select}
				onCancel={props.onCancel}
			/>
		</Portal>
	);
}

export function openSessionAccountSelector(tui: TUI, props: SessionAccountSelectorProps): OverlayDisposer {
	return mountOverlay(tui, () => <SessionAccountSelector {...props} />);
}
