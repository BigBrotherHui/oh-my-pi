/** Public reactive authoring primitives backed by the client Solid runtime. */
export {
	ErrorBoundary,
	For,
	Index,
	Match,
	Show,
	Suspense,
	Switch,
	batch,
	createContext,
	createEffect,
	createMemo,
	createResource,
	createRoot,
	createSignal,
	from,
	getOwner,
	mergeProps,
	on,
	onCleanup,
	onMount,
	runWithOwner,
	splitProps,
	untrack,
	useContext,
} from "solid-js";
export type { Accessor, JSX, Setter } from "solid-js";
export { createStore, produce, reconcile, unwrap } from "solid-js/store";
export { useFocus } from "../host/focus";
export type { FocusHandle } from "../host/focus";
export { useKeymap } from "../host/keymap";
export { useTui } from "../host/overlay";
export type { KeymapAccess } from "../host/keymap";
export { ThemeScope, useTheme } from "../theme/reactive";
export type { ThemeAccess, ThemeScopeProps } from "../theme/reactive";
export { createClock, registerClock, useClock } from "./clock";
export type { Clock, ClockCadence, ClockOptions, ClockSnapshot } from "./clock";
export { createCommitEffect, createLayoutEffect } from "./effects";
export { createGenerationGuard, fromEvent, fromSnapshots } from "./external";
export * from "./viewport";
export * from "./layout";
export type { EventSource, EventSubscriber, ExternalTeardown, GenerationGuard } from "./external";
