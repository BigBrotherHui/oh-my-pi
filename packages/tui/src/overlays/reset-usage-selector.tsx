import { centeredViewportRange } from "../components/scroll-viewport";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { SelectOption } from "../host/elements/select";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { matchesKey } from "../keys";
import { createMemo, createSignal, type JSX } from "../reactive";
import { useTheme } from "../theme/reactive";
import type { SizeValue, TUI } from "../tui";
import { createSelectController } from "./select-overlay";

const RESET_SELECTOR_MAX_VISIBLE = 10;

export interface ResetUsageAccount {
	label: string;
	availableCount: number;
	target: {
		credentialId?: number;
		accountId?: string;
		email?: string;
	};
	active: boolean;
	error?: string;
}

function accountKey(account: ResetUsageAccount): string {
	return `${account.target.credentialId ?? ""}:${account.target.accountId ?? ""}:${account.target.email ?? ""}:${account.label}`;
}

export interface ResetUsageSelectorProps {
	readonly accounts: readonly ResetUsageAccount[];
	readonly onSelect: (account: ResetUsageAccount) => void;
	readonly onCancel: () => void;
	readonly width?: SizeValue;
}

export function ResetUsageSelector(props: ResetUsageSelectorProps): JSX.Element {
	const palette = useTheme();
	const options: readonly SelectOption[] = props.accounts.map(account => ({
		value: accountKey(account),
		label: account.label,
	}));
	const firstRedeemable = Math.max(
		0,
		props.accounts.findIndex(account => account.availableCount > 0),
	);
	const [statusMessage, setStatusMessage] = createSignal<string>();
	const select = (value: string): void => {
		const account = props.accounts.find(candidate => accountKey(candidate) === value);
		if (!account) return;
		if (account.availableCount <= 0) {
			setStatusMessage("That account has no saved resets to spend.");
			return;
		}
		props.onSelect(account);
	};
	const confirmation = (value: string): string | undefined => {
		const account = props.accounts.find(candidate => accountKey(candidate) === value);
		if (!account || account.availableCount <= 0) return undefined;
		return `Press Enter again to spend 1 reset for ${account.label}, Esc to cancel`;
	};
	const controller = createSelectController({
		options: () => options,
		maxRows: () => RESET_SELECTOR_MAX_VISIBLE,
		selectedIndex: firstRedeemable,
		search: "never",
		onSelect: select,
		onCancel: props.onCancel,
		onChange: () => setStatusMessage(undefined),
		confirmation,
	});
	const consumeKey = (event: HostKeyEvent): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleKey = (event: HostKeyEvent): void => {
		if (matchesSelectCancel(event.data)) {
			setStatusMessage(undefined);
			controller.cancel();
			consumeKey(event);
		} else if (matchesSelectUp(event.data)) {
			controller.clearConfirmation();
			controller.move(-1, true);
			setStatusMessage(undefined);
			consumeKey(event);
		} else if (matchesSelectDown(event.data)) {
			controller.clearConfirmation();
			controller.move(1, true);
			setStatusMessage(undefined);
			consumeKey(event);
		} else if (matchesKey(event.data, "pageUp")) {
			controller.clearConfirmation();
			controller.move(-RESET_SELECTOR_MAX_VISIBLE, false);
			setStatusMessage(undefined);
			consumeKey(event);
		} else if (matchesKey(event.data, "pageDown")) {
			controller.clearConfirmation();
			controller.move(RESET_SELECTOR_MAX_VISIBLE, false);
			setStatusMessage(undefined);
			consumeKey(event);
		} else if (matchesKey(event.data, "enter") || matchesKey(event.data, "return") || event.data === "\n") {
			controller.activate();
			consumeKey(event);
		}
	};
	const viewport = createMemo(() =>
		centeredViewportRange(controller.selectedIndex(), props.accounts.length, RESET_SELECTOR_MAX_VISIBLE),
	);
	const visibleAccounts = createMemo(() => {
		const range = viewport();
		return props.accounts.slice(range.start, range.end).map((account, offset) => ({
			account,
			index: range.start + offset,
		}));
	});
	const handleListMouse = (event: HostMouseEvent): void => {
		if (event.action === "wheel" && event.wheel !== 0) {
			controller.move(event.wheel, false);
			event.preventDefault();
			event.stopPropagation();
		} else if (event.action === "move") {
			controller.setHoveredIndex(undefined);
		}
	};
	const handleRowMouse = (event: HostMouseEvent, index: number): void => {
		if (event.action === "wheel" && event.wheel !== 0) {
			controller.move(event.wheel, false);
		} else if (event.action === "move") {
			controller.setHoveredIndex(index);
		} else if (event.action === "down" && event.button === 0) {
			controller.activateIndex(index);
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};
	return (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"}>
			<box tabIndex={0} onKey={handleKey}>
				<frame
					title="Spend a saved rate-limit reset"
					paddingX={1}
					paddingY={0}
					borderPolicy="always"
					fitContent
					renderEmpty
				>
					<stack>
						{visibleAccounts().length > 0 ? (
							<scroll
								height={visibleAccounts().length}
								scrollbar="auto"
								trackColor="muted"
								thumbColor="accent"
								totalRows={props.accounts.length}
								offset={viewport().start}
								contentWindowed
								onMouse={handleListMouse}
							>
								<stack>
									{visibleAccounts().map(({ account, index }) => {
										const redeemable = account.availableCount > 0;
										const selected = controller.selectedIndex() === index;
										const countLabel = account.error
											? account.error
											: `${account.availableCount} saved reset${account.availableCount === 1 ? "" : "s"}`;
										const countColor = account.error ? "error" : redeemable ? "success" : "dim";
										return (
											<text wrap="clip" onMouse={event => handleRowMouse(event, index)}>
												{selected ? (
													<>
														<span color="accent">{palette.theme().nav.cursor} </span>
														<span color={redeemable ? "accent" : "dim"}>{account.label}</span>
													</>
												) : (
													<span color={redeemable ? undefined : "dim"}>
														{"  "}
														{account.label}
													</span>
												)}
												{account.active ? <span color="muted">{" (active)"}</span> : null}
												<span>{"  "}</span>
												<span color={countColor}>{countLabel}</span>
											</text>
										);
									})}
								</stack>
							</scroll>
						) : (
							<text color="muted" wrap="clip">
								No Codex accounts with saved resets
							</text>
						)}
						{controller.pendingMessage() ? (
							<text color="warning" wrap="clip">
								{controller.pendingMessage()}
							</text>
						) : (
							<text color="muted" wrap="clip">
								↑/↓ select · ↵ spend a reset · Esc cancel
							</text>
						)}
						{statusMessage() ? (
							<>
								<br />
								<text color="warning" wrap="clip">
									{statusMessage()}
								</text>
							</>
						) : null}
					</stack>
				</frame>
			</box>
		</Portal>
	);
}

export function openResetUsageSelector(tui: TUI, props: ResetUsageSelectorProps): OverlayDisposer {
	return mountOverlay(tui, () => <ResetUsageSelector {...props} />);
}
