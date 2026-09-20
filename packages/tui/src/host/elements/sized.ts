import { getOwner, runWithOwner, type JSX, type Owner } from "solid-js";
import type { Out } from "../../core/richtext";
import { registerElement } from "../registry";
import { createElement, insert, removeNode, render as renderHost } from "../renderer";
import { HOST_OWNER, type ElementImpl, type HostElement, type PaintContext } from "../types";
import { textPropDamage } from "./text";

/** Width-aware view factory, mounted under the surrounding reactive owner. */
export interface SizedProps {
	readonly paint: (width: number) => JSX.Element;
}

interface SizedState {
	readonly owner: Owner | null;
	width: number;
	key?: unknown;
	factory?: SizedProps["paint"];
	dispose?: () => void;
}

function stateOf(node: HostElement): SizedState {
	if (node.state === undefined) {
		node.state = { owner: node[HOST_OWNER] ?? getOwner(), width: -1 } satisfies SizedState;
	}
	return node.state as SizedState;
}

function isViewFactory(value: unknown): value is SizedProps["paint"] {
	return typeof value === "function";
}

function paintSized(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const factory = node.props.paint;
	if (!isViewFactory(factory)) throw new TypeError("<sized> requires a paint view factory");
	const state = stateOf(node);
	const available = Math.max(0, Math.trunc(width));
	if (state.width !== available || state.factory !== factory || state.key !== node.props.key) {
		state.dispose?.();
		while (node.children.length > 0) removeNode(node, node.children[node.children.length - 1]!);
		state.width = available;
		state.key = node.props.key;
		state.factory = factory;
		runWithOwner(state.owner, () => {
			state.dispose = renderHost(() => {
				const content = createElement("stack");
				insert(content, () => factory(available));
				return content;
			}, node);
		});
	}
	for (const child of node.children) ctx.paintChild(child, out, available);
}

/** Retained width-dependent subtree; returned inputs and resources get normal host lifecycles. */
export const sizedElement: ElementImpl = {
	tag: "sized",
	propDamage: textPropDamage,
	onAttach(node) {
		stateOf(node);
	},
	onDetach(node) {
		const state = stateOf(node);
		state.dispose?.();
		node.state = undefined;
	},
	paint: paintSized,
};

registerElement(sizedElement);
