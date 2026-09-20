import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { centeredViewportRange } from "../components/scroll-viewport";
import { fuzzyFilter } from "../fuzzy";
import { extractPrintableText, matchesKey } from "../keys";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import {
	createEffect,
	createMemo,
	createSignal,
	onCleanup,
	onMount,
	useClock,
	useFocus,
	type Accessor,
	type JSX,
} from "../reactive";
import { Portal, mountOverlay, type OverlayDisposer } from "../host/overlay";
import type { HostKeyEvent, HostMouseEvent } from "../host/input";
import type { SizeValue, TUI } from "../tui";
import { useTheme } from "../theme/reactive";

const OAUTH_SELECTOR_MAX_VISIBLE = 10;
const LIST_ROW_OFFSET = 1;

type CredentialOriginKind = "runtime" | "config" | "oauth" | "api_key" | "env" | "fallback";

export interface OAuthSelectorAuthSource {
	has(providerId: string): boolean;
	hasAuth(providerId: string): boolean;
	getCredentialOrigin(providerId: string): { kind: CredentialOriginKind; envVar?: string } | undefined;
}

const ORIGIN_LABELS: Readonly<Record<CredentialOriginKind, string>> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};

type ValidationState = "checking" | "valid" | "invalid";

export interface OAuthSelectorProps {
	readonly mode: "login" | "logout";
	readonly authStorage: OAuthSelectorAuthSource;
	readonly onSelect: (providerId: string) => void;
	readonly onCancel: () => void;
	readonly disabledProviders?: readonly string[];
	readonly validateAuth?: (providerId: string) => Promise<boolean>;
	readonly width?: SizeValue;
	/** Whether a mounted inline selector is the active scene and may own focus. */
	readonly active?: Accessor<boolean>;
	/** Maximum terminal rows available to the selector, including its frame. */
	readonly maxHeight?: number;
	/** Render inside an existing modal or wizard instead of creating a portal. */
	readonly inline?: boolean;
}

interface OAuthProviderRowProps {
	readonly provider: OAuthProviderInfo;
	readonly index: number;
	readonly mode: "login" | "logout";
	readonly authStorage: OAuthSelectorAuthSource;
	readonly validations: Accessor<Readonly<Record<string, ValidationState>>>;
	readonly now: Accessor<number>;
	readonly selectedIndex: Accessor<number>;
	readonly hoveredIndex: Accessor<number | null>;
	readonly onHover: (index: number) => void;
	readonly onWheel: (delta: -1 | 1) => void;
	readonly onSelect: (index: number) => void;
}

function providerSource(props: OAuthSelectorProps): readonly OAuthProviderInfo[] {
	const providers = getOAuthProviders();
	if (props.mode === "logout") return providers.filter(provider => props.authStorage.has(provider.id));
	const disabled = new Set(props.disabledProviders);
	return providers.filter(
		provider =>
			!disabled.has(provider.id) && !(provider.storeCredentialsAs && disabled.has(provider.storeCredentialsAs)),
	);
}

function credentialSource(authStorage: OAuthSelectorAuthSource, providerId: string): string {
	const origin = authStorage.getCredentialOrigin(providerId);
	if (!origin) return "";
	return origin.kind === "env" && origin.envVar ? `env: ${origin.envVar}` : ORIGIN_LABELS[origin.kind];
}

function providerSearchText(provider: OAuthProviderInfo, authStorage: OAuthSelectorAuthSource): string {
	let text = `${provider.name} ${provider.id}`;
	const origin = authStorage.getCredentialOrigin(provider.id);
	if (origin) {
		text += ` logged in authenticated ${ORIGIN_LABELS[origin.kind]}`;
		if (origin.envVar) text += ` ${origin.envVar}`;
	}
	if (!provider.available) text += " unavailable";
	return text;
}

function maxVisibleRows(maxHeight: number | undefined): number {
	if (maxHeight === undefined) return OAUTH_SELECTOR_MAX_VISIBLE;
	const lines = Math.max(1, Math.trunc(maxHeight));
	const strict = lines - LIST_ROW_OFFSET - 2;
	const relaxed = lines - LIST_ROW_OFFSET - 1;
	return Math.min(OAUTH_SELECTOR_MAX_VISIBLE, Math.max(1, strict, Math.min(relaxed, 3)));
}

function OAuthProviderRow(props: OAuthProviderRowProps): JSX.Element {
	const palette = useTheme();
	const status = (): JSX.Element => {
		const validation = props.validations()[props.provider.id];
		const sourceText = credentialSource(props.authStorage, props.provider.id);
		const sourceSuffix = sourceText ? <span color="muted"> ({sourceText})</span> : null;
		if (validation === "checking") {
			const frames = palette.theme().spinnerFrames;
			const spinner =
				frames.length > 0 ? frames[Math.floor(props.now() / 80) % frames.length] : palette.theme().status.pending;
			return (
				<>
					<span color="warning"> {spinner} checking</span>
					{sourceSuffix}
				</>
			);
		}
		if (validation === "invalid")
			return (
				<>
					<span color="error"> {palette.theme().status.error} invalid</span>
					{sourceSuffix}
				</>
			);
		const authenticated =
			props.mode === "logout"
				? props.authStorage.has(props.provider.id)
				: props.authStorage.hasAuth(props.provider.id);
		if (validation === "valid" || authenticated)
			return (
				<>
					<span color="success"> {palette.theme().status.enabled} logged in</span>
					{sourceSuffix}
				</>
			);
		return null;
	};
	const handleMouse = (event: HostMouseEvent): void => {
		if (event.action === "wheel" && event.wheel !== 0) {
			props.onWheel(event.wheel);
			event.stopPropagation();
			return;
		}
		if (event.action === "move") {
			props.onHover(props.index);
			event.stopPropagation();
			return;
		}
		if (event.action === "down" && event.button === 0) {
			props.onSelect(props.index);
			event.stopPropagation();
		}
	};
	return (
		<text
			wrap="clip"
			background={
				props.selectedIndex() !== props.index && props.hoveredIndex() === props.index ? "selectedBg" : undefined
			}
			onMouse={handleMouse}
		>
			{props.selectedIndex() === props.index ? (
				<>
					<span color="accent">{palette.theme().nav.cursor} </span>
					<span color={props.provider.available ? "accent" : "dim"}>{props.provider.name}</span>
				</>
			) : (
				<span color={props.provider.available ? undefined : "dim"}> {props.provider.name}</span>
			)}
			{status()}
		</text>
	);
}

/** Reactive OAuth provider selector with search, validation, and mouse support. */
export function OAuthSelector(props: OAuthSelectorProps): JSX.Element {
	const selectorFocus = useFocus();
	const providers = providerSource(props);
	const [validations, setValidations] = createSignal<Readonly<Record<string, ValidationState>>>({});
	const [query, setQuery] = createSignal("");
	const [selectedIndex, setSelectedIndex] = createSignal(providers.length > 0 ? 0 : -1);
	const [hoveredIndex, setHoveredIndex] = createSignal<number | null>(null);
	const [statusMessage, setStatusMessage] = createSignal<string>();
	const now = useClock("spinner");
	const visibleLimit = () => maxVisibleRows(props.maxHeight);
	const filteredProviders = createMemo(() => {
		const text = query().trim();
		return text
			? fuzzyFilter([...providers], text, provider => providerSearchText(provider, props.authStorage))
			: providers;
	});
	const viewport = createMemo(() =>
		centeredViewportRange(selectedIndex(), filteredProviders().length, visibleLimit()),
	);
	const visibleProviders = createMemo(() => {
		const range = viewport();
		return filteredProviders()
			.slice(range.start, range.end)
			.map((provider, offset) => ({ provider, index: range.start + offset }));
	});
	const searchEnabled = () => providers.length > visibleLimit();
	let active = true;
	const finish = (callback: () => void): void => {
		active = false;
		callback();
	};
	onMount(() => {
		if (!props.validateAuth) return;
		for (const provider of providers) {
			const hasCredentials =
				props.mode === "logout" ? props.authStorage.has(provider.id) : props.authStorage.hasAuth(provider.id);
			if (!hasCredentials) continue;
			setValidations(previous => ({ ...previous, [provider.id]: "checking" }));
			void props.validateAuth(provider.id).then(
				valid => {
					if (active) setValidations(previous => ({ ...previous, [provider.id]: valid ? "valid" : "invalid" }));
				},
				() => {
					if (active) setValidations(previous => ({ ...previous, [provider.id]: "invalid" }));
				},
			);
		}
	});
	onCleanup(() => {
		active = false;
	});
	createEffect(() => {
		if (props.active?.() ?? true) selectorFocus.focus();
		else selectorFocus.blur();
	});
	const setSearchQuery = (value: string): void => {
		setQuery(value);
		setSelectedIndex(filteredProviders().length > 0 ? 0 : -1);
		setStatusMessage(undefined);
	};
	const move = (delta: number, wrap: boolean): boolean => {
		const total = filteredProviders().length;
		if (total === 0) return false;
		const current = selectedIndex() < 0 ? 0 : selectedIndex();
		const next = wrap ? (current + delta + total) % total : Math.max(0, Math.min(total - 1, current + delta));
		if (next === current) return false;
		setSelectedIndex(next);
		return true;
	};
	const confirmSelection = (): void => {
		const selected = filteredProviders()[selectedIndex()];
		if (!selected) return;
		if (selected.available) {
			setStatusMessage(undefined);
			finish(() => props.onSelect(selected.id));
		} else {
			setStatusMessage("Provider unavailable in this environment.");
		}
	};
	const handleWheel = (delta: -1 | 1): void => {
		if (move(delta, false)) setStatusMessage(undefined);
	};
	const handleRowSelect = (index: number): void => {
		if (index !== selectedIndex()) {
			setSelectedIndex(index);
			setStatusMessage(undefined);
		}
		confirmSelection();
	};
	const handleKey = (event: HostKeyEvent): void => {
		const data = event.data;
		if (matchesSelectCancel(data)) {
			finish(props.onCancel);
			event.preventDefault();
			return;
		}
		if (searchEnabled()) {
			if (matchesKey(data, "backspace")) {
				if (query().length > 0) {
					setSearchQuery(Array.from(query()).slice(0, -1).join(""));
					event.preventDefault();
				}
				return;
			}
			const printable = extractPrintableText(data);
			if (printable !== undefined && (query().length > 0 || printable.trim().length > 0)) {
				setSearchQuery(query() + printable);
				event.preventDefault();
				return;
			}
		}
		if (matchesSelectUp(data)) {
			move(-1, true);
			setStatusMessage(undefined);
			event.preventDefault();
			return;
		}
		if (matchesSelectDown(data)) {
			move(1, true);
			setStatusMessage(undefined);
			event.preventDefault();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			move(-visibleLimit(), false);
			setStatusMessage(undefined);
			event.preventDefault();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			move(visibleLimit(), false);
			setStatusMessage(undefined);
			event.preventDefault();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			confirmSelection();
			event.preventDefault();
		}
	};
	const selector = (
		<box tabIndex={selectorFocus.tabIndex} onKey={handleKey}>
			<frame
				title={props.mode === "login" ? "Select provider to login" : "Select provider to logout"}
				paddingX={1}
				paddingY={0}
				borderPolicy="always"
				fitContent
				renderEmpty
				onMouse={event => {
					if (event.action === "wheel" && event.wheel !== 0) handleWheel(event.wheel);
					else if (event.action === "move") setHoveredIndex(null);
				}}
			>
				<stack>
					{visibleProviders().length > 0 ? (
						<scroll
							height={visibleProviders().length}
							scrollbar="auto"
							trackColor="muted"
							thumbColor="accent"
							totalRows={filteredProviders().length}
							offset={viewport().start}
							contentWindowed
							onMouse={event => {
								if (event.action === "wheel" && event.wheel !== 0) handleWheel(event.wheel);
								else if (event.action === "move") setHoveredIndex(null);
							}}
						>
							<stack>
								{visibleProviders().map(row => (
									<OAuthProviderRow
										provider={row.provider}
										index={row.index}
										mode={props.mode}
										authStorage={props.authStorage}
										validations={validations}
										now={now}
										selectedIndex={selectedIndex}
										hoveredIndex={hoveredIndex}
										onHover={setHoveredIndex}
										onWheel={handleWheel}
										onSelect={handleRowSelect}
									/>
								))}
							</stack>
						</scroll>
					) : null}
					{searchEnabled() || query().length > 0 ? (
						<text color="muted" wrap="clip">
							{query().trim() ? `Search: ${query()}` : "Type to search"}
						</text>
					) : null}
					{filteredProviders().length === 0 ? (
						<text color="muted" wrap="clip">
							{providers.length === 0
								? props.mode === "login"
									? "No OAuth providers available"
									: "No stored provider credentials to log out"
								: "No matching providers"}
						</text>
					) : null}
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
	);
	return props.inline ? (
		selector
	) : (
		<Portal to="overlay" anchor="bottom-center" width={props.width ?? "100%"} maxHeight={props.maxHeight}>
			{selector}
		</Portal>
	);
}

export function openOAuthSelector(tui: TUI, props: OAuthSelectorProps): OverlayDisposer {
	return mountOverlay(tui, () => <OAuthSelector {...props} maxHeight={props.maxHeight ?? tui.terminal.rows} />);
}
