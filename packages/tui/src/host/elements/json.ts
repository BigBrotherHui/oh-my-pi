import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import { pipe, Wrap } from "../../core/out";
import type { Out } from "../../core/richtext";
import { instrument } from "../../instrumentation";
import type { SyntaxRole } from "../../style/resolve";
import { resolveSyntaxRole } from "../../style/resolve";
import type { StyleProps } from "../../style/types";
import type { Theme } from "../../theme/theme";
import { truncateToWidth } from "../../utils";
import { registerElement } from "../registry";
import { Damage, type ElementImpl, type HostElement, type LayoutProps, type PaintContext } from "../types";
import { textPropDamage } from "./text";

/** Sanitizer applied to JSON keys and string values before painting. */
export type JsonTextSanitizer = (value: string) => string;

/** Observable result of a bounded JSON projection. */
export interface JsonResult {
	readonly truncated: boolean;
	readonly rows: number;
}

/** Props for the retained JSON-tree intrinsic. */
export interface JsonProps extends LayoutProps, StyleProps {
	readonly value: unknown;
	readonly depth?: number;
	readonly maxDepth?: number;
	readonly maxLines?: number;
	readonly maxScalarLength?: number;
	readonly sanitizeText?: JsonTextSanitizer;
	readonly hiddenRootKeys?: readonly string[];
	readonly multilineStrings?: boolean;
	readonly escapeStringWhitespace?: boolean;
	readonly rootConnectors?: "hooked" | "siblings";
	readonly onResult?: (result: JsonResult) => void;
}

type JsonNodeKind = "array" | "object" | "scalar" | "placeholder";

interface JsonNode {
	readonly key: string | undefined;
	readonly value: unknown;
	readonly depth: number;
	readonly kind: JsonNodeKind;
}

interface PendingNode {
	readonly node: JsonNode;
	readonly siblingIndex: number;
	readonly siblingCount: number;
	readonly ancestorLast: readonly boolean[];
}

interface PrefixPart {
	readonly text: string;
	readonly dim: boolean;
}

interface JsonRow {
	readonly prefix: readonly PrefixPart[];
	readonly label?: string;
	readonly suffix?: string;
	readonly suffixDim?: boolean;
	readonly value?: string;
	readonly role?: SyntaxRole;
}

interface JsonProjection {
	readonly rows: readonly JsonRow[];
	readonly result: JsonResult;
	readonly value: unknown;
	readonly depth: number | undefined;
	readonly maxDepth: number | undefined;
	readonly maxLines: number | undefined;
	readonly maxScalarLength: number | undefined;
	readonly sanitizer: JsonTextSanitizer | undefined;
	readonly hiddenRootKeys: readonly string[] | undefined;
	readonly multilineStrings: boolean | undefined;
	readonly escapeStringWhitespace: boolean | undefined;
	readonly rootConnectors: "hooked" | "siblings" | undefined;
	readonly symbolSignature: string;
}

const DEFAULT_HIDDEN_ROOT_KEYS: readonly string[] = [INTENT_FIELD, "__partialJson"];

function propsOf(node: HostElement): JsonProps {
	return node.props as unknown as JsonProps;
}

function nodeKind(value: unknown): JsonNodeKind {
	if (Array.isArray(value)) return "array";
	if (isRecord(value)) return "object";
	return "scalar";
}

function children(node: JsonNode, maxDepth: number): JsonNode[] {
	if (node.kind === "array" && Array.isArray(node.value)) {
		if (node.value.length === 0) return [];
		if (node.depth >= maxDepth) {
			return [{ key: undefined, value: undefined, depth: node.depth + 1, kind: "placeholder" }];
		}
		return node.value.map((value, index) => ({
			key: `[${index}]`,
			value,
			depth: node.depth + 1,
			kind: nodeKind(value),
		}));
	}
	if (node.kind === "object" && isRecord(node.value)) {
		if (node.depth >= maxDepth) {
			return [{ key: undefined, value: undefined, depth: node.depth + 1, kind: "placeholder" }];
		}
		const result: JsonNode[] = [];
		for (const key in node.value) {
			const value = node.value[key];
			result.push({ key, value, depth: node.depth + 1, kind: nodeKind(value) });
		}
		return result;
	}
	return [];
}

function standardPrefix(
	theme: Theme,
	ancestors: readonly boolean[],
	last: boolean,
	continuation: boolean,
): PrefixPart[] {
	const prefix: PrefixPart[] = [];
	for (const ancestorLast of ancestors) {
		if (ancestorLast) prefix.push({ text: "   ", dim: false });
		else prefix.push({ text: theme.tree.vertical, dim: false }, { text: "  ", dim: false });
	}
	if (continuation) {
		if (last) prefix.push({ text: "   ", dim: false });
		else prefix.push({ text: theme.tree.vertical, dim: false }, { text: "  ", dim: false });
	} else {
		prefix.push({ text: last ? theme.tree.last : theme.tree.branch, dim: true }, { text: " ", dim: false });
	}
	return prefix;
}

function rootGutter(theme: Theme): PrefixPart[] {
	return [
		{ text: " ".repeat(Bun.stringWidth(theme.tree.hook)), dim: false },
		{ text: " ", dim: false },
		{ text: " ".repeat(Bun.stringWidth(theme.format.bullet)), dim: false },
		{ text: " ", dim: false },
	];
}

function continuationPrefix(theme: Theme, pending: PendingNode, hooked: boolean): PrefixPart[] {
	const last = pending.siblingIndex === pending.siblingCount - 1;
	const root = pending.ancestorLast.length === 0;
	if (hooked && root) return rootGutter(theme);
	if (hooked) return [...rootGutter(theme), ...standardPrefix(theme, pending.ancestorLast.slice(1), last, true)];
	return standardPrefix(theme, pending.ancestorLast, last, true);
}

function scalarText(value: unknown, maxLength: number, escapeWhitespace: boolean): { text: string; role: SyntaxRole } {
	if (typeof value === "string") {
		const source = escapeWhitespace ? value.replaceAll("\n", "\\n").replaceAll("\t", "\\t") : value;
		return { text: `"${truncateToWidth(source, maxLength)}"`, role: "string" };
	}
	if (typeof value === "number") return { text: truncateToWidth(String(value), maxLength), role: "number" };
	if (typeof value === "boolean" || value === null || value === undefined) {
		return { text: truncateToWidth(String(value), maxLength), role: "keyword" };
	}
	return { text: truncateToWidth(String(value), maxLength), role: "text" };
}

function symbolSignature(theme: Theme): string {
	return `${theme.tree.vertical}\0${theme.tree.last}\0${theme.tree.branch}\0${theme.tree.hook}\0${theme.format.bullet}`;
}

function projectionMatches(projection: JsonProjection, props: JsonProps, theme: Theme): boolean {
	return (
		projection.value === props.value &&
		projection.depth === props.depth &&
		projection.maxDepth === props.maxDepth &&
		projection.maxLines === props.maxLines &&
		projection.maxScalarLength === props.maxScalarLength &&
		projection.sanitizer === props.sanitizeText &&
		projection.hiddenRootKeys === props.hiddenRootKeys &&
		projection.multilineStrings === props.multilineStrings &&
		projection.escapeStringWhitespace === props.escapeStringWhitespace &&
		projection.rootConnectors === props.rootConnectors &&
		projection.symbolSignature === symbolSignature(theme)
	);
}

function buildProjection(props: JsonProps, theme: Theme): JsonProjection {
	instrument.parse();
	const depth = Math.max(0, Math.trunc(props.depth ?? 0));
	const maxDepth = Math.max(depth, Math.trunc(props.maxDepth ?? 6));
	const maxLines = Math.max(0, Math.trunc(props.maxLines ?? 200));
	const maxScalarLength = Math.max(0, Math.trunc(props.maxScalarLength ?? 2000));
	const hidden = props.hiddenRootKeys ?? DEFAULT_HIDDEN_ROOT_KEYS;
	const hooked = (props.rootConnectors ?? "hooked") === "hooked";
	const clean = (value: string): string => sanitizeText(props.sanitizeText?.(value) ?? value);
	let roots: JsonNode[];
	if (isRecord(props.value)) {
		roots = [];
		for (const key in props.value) {
			if (hidden.includes(key)) continue;
			const value = props.value[key];
			roots.push({ key, value, depth: depth + 1, kind: nodeKind(value) });
		}
	} else if (Array.isArray(props.value)) {
		roots = props.value.map((value, index) => ({
			key: `[${index}]`,
			value,
			depth: depth + 1,
			kind: nodeKind(value),
		}));
	} else {
		roots = [{ key: undefined, value: props.value, depth, kind: nodeKind(props.value) }];
	}
	const stack: PendingNode[] = [];
	for (let index = roots.length - 1; index >= 0; index--) {
		stack.push({ node: roots[index]!, siblingIndex: index, siblingCount: roots.length, ancestorLast: [] });
	}
	const rows: JsonRow[] = [];
	let scalarTruncated = false;
	while (stack.length > 0 && rows.length < maxLines) {
		const pending = stack.pop()!;
		const last = pending.siblingIndex === pending.siblingCount - 1;
		const descendants = children(pending.node, maxDepth);
		for (let index = descendants.length - 1; index >= 0; index--) {
			stack.push({
				node: descendants[index]!,
				siblingIndex: index,
				siblingCount: descendants.length,
				ancestorLast: [...pending.ancestorLast, last],
			});
		}
		const root = pending.ancestorLast.length === 0;
		const prefix =
			hooked && root
				? [
						{
							text: pending.siblingIndex === 0 ? theme.tree.hook : " ".repeat(Bun.stringWidth(theme.tree.hook)),
							dim: pending.siblingIndex === 0,
						},
						{ text: " ", dim: false },
						{ text: theme.format.bullet, dim: true },
						{ text: " ", dim: false },
					]
				: [
						...(hooked ? rootGutter(theme) : []),
						...standardPrefix(theme, hooked ? pending.ancestorLast.slice(1) : pending.ancestorLast, last, false),
					];
		if (pending.node.kind === "placeholder") {
			rows.push({ prefix, value: "…", role: "text" });
			continue;
		}
		const label = clean(
			pending.node.key ??
				(pending.node.kind === "array" ? "array" : pending.node.kind === "object" ? "object" : "value"),
		);
		if (pending.node.kind === "array" && Array.isArray(pending.node.value)) {
			rows.push({ prefix, label, suffix: ` [${pending.node.value.length}]` });
			continue;
		}
		if (pending.node.kind === "object" && isRecord(pending.node.value)) {
			rows.push({ prefix, label, suffix: ` {${Object.keys(pending.node.value).length}}` });
			continue;
		}
		const raw = typeof pending.node.value === "string" ? clean(pending.node.value) : pending.node.value;
		if (typeof raw === "string" && (props.multilineStrings ?? true) && raw.includes("\n")) {
			const lines = raw.split("\n");
			const count = Math.min(lines.length, Math.max(1, maxLines - rows.length));
			for (let index = 0; index < count; index++) {
				rows.push({
					prefix:
						index === 0
							? prefix
							: [
									...continuationPrefix(theme, pending, hooked),
									{ text: " ".repeat(Bun.stringWidth(label) + 3), dim: false },
								],
					label: index === 0 ? label : undefined,
					suffix: index === 0 ? ": " : undefined,
					suffixDim: false,
					value: `${index === 0 ? '"' : ""}${truncateToWidth(lines[index] ?? "", maxScalarLength)}${index === lines.length - 1 ? '"' : ""}`,
					role: "string",
				});
			}
			if (count < lines.length) scalarTruncated = true;
			continue;
		}
		const scalar = scalarText(raw, maxScalarLength, props.escapeStringWhitespace ?? true);
		rows.push({ prefix, label, suffix: ": ", suffixDim: false, value: scalar.text, role: scalar.role });
	}
	return {
		rows,
		result: { rows: rows.length, truncated: scalarTruncated || stack.length > 0 },
		value: props.value,
		depth: props.depth,
		maxDepth: props.maxDepth,
		maxLines: props.maxLines,
		maxScalarLength: props.maxScalarLength,
		sanitizer: props.sanitizeText,
		hiddenRootKeys: props.hiddenRootKeys,
		multilineStrings: props.multilineStrings,
		escapeStringWhitespace: props.escapeStringWhitespace,
		rootConnectors: props.rootConnectors,
		symbolSignature: symbolSignature(theme),
	};
}

function paintJson(node: HostElement, out: Out, width: number, ctx: PaintContext): void {
	const props = propsOf(node);
	let projection = node.state as JsonProjection | undefined;
	if (projection === undefined || !projectionMatches(projection, props, ctx.theme)) {
		projection = buildProjection(props, ctx.theme);
		node.state = projection;
	}
	props.onResult?.(projection.result);
	const base = ctx.styleOf(node);
	const dim = ctx.theme.style("dim").over(base);
	const label = ctx.theme.style("muted").over(base);
	const safeWidth = Math.max(0, Math.trunc(width));
	for (const row of projection.rows) {
		if (safeWidth === 0) {
			out.br();
			continue;
		}
		const valueStyle =
			row.role === undefined || row.role === "text" ? base : resolveSyntaxRole(ctx.theme, row.role).over(base);
		pipe(new Wrap(out, safeWidth), sink => {
			for (const part of row.prefix) sink.push(part.dim ? dim : base, part.text);
			if (row.label !== undefined) sink.push(label, row.label);
			if (row.suffix !== undefined) sink.push(row.suffixDim === false ? base : dim, row.suffix);
			if (row.value !== undefined) sink.push(valueStyle, row.value);
			sink.br();
		});
	}
}

/** Retained implementation of the `json` intrinsic. */
export const jsonElement: ElementImpl = {
	tag: "json",
	propDamage(name) {
		if (name === "color" || name === "background" || name === "style" || name === "recipe") return Damage.Paint;
		return textPropDamage(name);
	},
	paint: paintJson,
};

registerElement(jsonElement);
