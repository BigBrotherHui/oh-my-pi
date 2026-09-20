import { createMemo, createSignal, For, type JSX, useTheme } from "../reactive";
import { matchesKey } from "../keys";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent } from "../host/input";
import { centeredViewportRange } from "../components/scroll-viewport";
import type { SizeValue, TUI } from "../tui";

const LOGOUT_SELECTOR_MAX_VISIBLE = 10;

export interface LogoutAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

export interface LogoutAccountSelectorProps {
	readonly providerName: string;
	readonly accounts: readonly LogoutAccount[];
	readonly onSelect: (account: LogoutAccount) => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

/** Account picker for `/logout` after the provider has been selected. */
export function LogoutAccountSelector(props: LogoutAccountSelectorProps): JSX.Element {
	const theme = useTheme();
	const [selectedIndex, setSelectedIndex] = createSignal(
		Math.max(
			0,
			props.accounts.findIndex(account => account.active),
		),
	);
	const range = createMemo(() =>
		centeredViewportRange(selectedIndex(), props.accounts.length, LOGOUT_SELECTOR_MAX_VISIBLE),
	);
	const visibleAccounts = createMemo(() => props.accounts.slice(range().start, range().end));

	const move = (amount: number, wrap: boolean): void => {
		const count = props.accounts.length;
		if (count === 0 || amount === 0) return;
		const direction = amount < 0 ? -1 : 1;
		let remaining = Math.abs(Math.trunc(amount));
		let index = selectedIndex();
		while (remaining > 0) {
			const next = index + direction;
			if (next < 0 || next >= count) {
				if (!wrap) break;
				index = direction > 0 ? 0 : count - 1;
			} else {
				index = next;
			}
			remaining -= 1;
		}
		setSelectedIndex(index);
	};

	const selectCurrent = (): void => {
		const account = props.accounts[selectedIndex()];
		if (account) props.onSelect(account);
	};

	const handleKey = (event: HostKeyEvent): boolean => {
		if (matchesSelectCancel(event.data)) {
			props.onCancel();
			return true;
		}
		if (matchesSelectUp(event.data)) {
			move(-1, true);
			return true;
		}
		if (matchesSelectDown(event.data)) {
			move(1, true);
			return true;
		}
		if (matchesKey(event.data, "pageUp")) {
			move(-LOGOUT_SELECTOR_MAX_VISIBLE, false);
			return true;
		}
		if (matchesKey(event.data, "pageDown")) {
			move(LOGOUT_SELECTOR_MAX_VISIBLE, false);
			return true;
		}
		if (matchesKey(event.data, "enter") || matchesKey(event.data, "return") || event.data === "\n") {
			selectCurrent();
			return true;
		}
		return false;
	};

	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box onKey={handleKey} tabIndex={0}>
				<frame
					title={`Select ${props.providerName} account to log out`}
					paddingX={1}
					paddingY={0}
					borderPolicy="always"
					fitContent
					renderEmpty
				>
					{props.accounts.length === 0 ? (
						<text color="muted" wrap="clip">
							No stored accounts to log out
						</text>
					) : (
						<scroll
							height={visibleAccounts().length}
							totalRows={props.accounts.length}
							offset={range().start}
							contentWindowed
							scrollbar="auto"
							trackColor="muted"
							thumbColor="accent"
						>
							<For each={visibleAccounts()}>
								{(account, index) => {
									const selected = () => range().start + index() === selectedIndex();
									return (
										<text color={selected() ? "accent" : undefined} wrap="clip">
											{selected() ? `${theme.symbol("nav.cursor")} ` : "  "}
											{account.label}
											{account.active ? <span color="muted"> (active)</span> : null}
											{account.detail ? <span color="dim"> {account.detail}</span> : null}
										</text>
									);
								}}
							</For>
						</scroll>
					)}
					<text color="muted" wrap="clip">
						↑/↓ select · ↵ log out account · Esc cancel
					</text>
				</frame>
			</box>
		</Portal>
	);
}

export function openLogoutAccountSelector(tui: TUI, props: LogoutAccountSelectorProps): OverlayDisposer {
	return mountOverlay(tui, () => <LogoutAccountSelector {...props} />);
}
