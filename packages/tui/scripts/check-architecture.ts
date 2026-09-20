import { parse, type ParserPlugin } from "@babel/parser";
import traverse, { type Binding, type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const reactiveViewRoot = resolve(packageRoot, "src/view");

const viewDirectories = [
	resolve(packageRoot, "src/tools"),
	resolve(packageRoot, "src/chat"),
	reactiveViewRoot,
	resolve(packageRoot, "src/overlays"),
	resolve(packageRoot, "src/status-line"),
	resolve(packageRoot, "src/apps"),
	resolve(packageRoot, "src/setup"),
	resolve(repositoryRoot, "packages/coding-agent/src/modes"),
];
const sourceDirectories = [resolve(packageRoot, "src"), resolve(repositoryRoot, "packages/coding-agent/src/modes")];
const sourceExtensions: Readonly<Record<string, true>> = { ".js": true, ".jsx": true, ".ts": true, ".tsx": true };
const renderCallbacks: Readonly<Record<string, true>> = { render: true, mount: true, createMemo: true };
const actionCallbacks: Readonly<Record<string, true>> = { action: true, createAction: true };
const allowedSolidDirectories = ["reactive", "host", "compiler", "compositor", "document", "style", "theme"];

export interface Violation {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
	readonly source: string;
}

export interface AnalysisOptions {
	readonly file: string;
	readonly isView: boolean;
	readonly allowsDirectSolidImport?: boolean;
}

interface FunctionInfo {
	readonly calls: Set<Binding>;
	readonly clocks: t.CallExpression[];
	directRender: boolean;
	excluded: boolean;
	renders: boolean;
}

function normalized(path: string): string {
	return path.split(sep).join("/");
}

async function sourceFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return files;
		throw error;
	}
	for (const entry of entries) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && sourceExtensions[extname(entry.name)]) files.push(path);
	}
	return files;
}

function sourceLine(content: string, line: number): string {
	return content.split("\n")[line - 1]?.trim() ?? "";
}

function functionName(path: NodePath<t.Function>): string | undefined {
	if (path.isFunctionDeclaration() && path.node.id) return path.node.id.name;
	if (path.parentPath.isVariableDeclarator() && t.isIdentifier(path.parentPath.node.id))
		return path.parentPath.node.id.name;
	return undefined;
}

function functionBinding(path: NodePath<t.Function>, name: string): Binding | undefined {
	if (path.isFunctionDeclaration()) return path.parentPath.scope.getBinding(name);
	return path.scope.getBinding(name);
}

function isJsxExpression(node: t.Node | null | undefined): boolean {
	if (!node) return false;
	if (t.isJSXElement(node) || t.isJSXFragment(node)) return true;
	if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node) || t.isTypeCastExpression(node))
		return isJsxExpression(node.expression);
	return false;
}

function returnsJsx(path: NodePath<t.Function>): boolean {
	if (isJsxExpression(path.node.body)) return true;
	let found = false;
	path.traverse({
		Function(inner) {
			if (inner.node !== path.node) inner.skip();
		},
		ReturnStatement(returned) {
			if (isJsxExpression(returned.node.argument)) found = true;
		},
	});
	return found;
}

function memberName(member: t.MemberExpression): string | undefined {
	if (!member.computed && t.isIdentifier(member.property)) return member.property.name;
	if (member.computed && t.isStringLiteral(member.property)) return member.property.value;
	return undefined;
}

function isNamedCallback(
	callee: t.Expression | t.Super | t.V8IntrinsicIdentifier,
	names: Readonly<Record<string, true>>,
	bindings: ReadonlySet<Binding> | undefined,
	path: NodePath<t.CallExpression>,
): boolean {
	if (t.isIdentifier(callee)) {
		const binding = path.scope.getBinding(callee.name);
		return names[callee.name] === true || (binding !== undefined && bindings?.has(binding) === true);
	}
	const name = t.isMemberExpression(callee) ? memberName(callee) : undefined;
	return name !== undefined && names[name] === true;
}

function isDateNow(call: t.CallExpression): boolean {
	return (
		t.isMemberExpression(call.callee) &&
		t.isIdentifier(call.callee.object, { name: "Date" }) &&
		memberName(call.callee) === "now"
	);
}

function isEventOrActionName(name: string): boolean {
	return /^on[A-Z]/u.test(name) || name === "action" || name === "actions";
}

function isDirectSolidImport(path: NodePath<t.ImportDeclaration>): boolean {
	return path.node.source.value === "solid-js" || path.node.source.value.startsWith("solid-js/");
}

function implementsComponent(item: t.ClassImplements | t.TSExpressionWithTypeArguments): boolean {
	return (
		(t.isClassImplements(item) && item.id.name === "Component") ||
		(t.isTSExpressionWithTypeArguments(item) && t.isIdentifier(item.expression, { name: "Component" }))
	);
}

function isForbiddenCall(call: t.CallExpression): string | undefined {
	const { callee } = call;
	if (t.isIdentifier(callee)) {
		if (callee.name === "requestRender") return "requestRender()";
		if (callee.name === "requestComponentRender") return "requestComponentRender()";
		if (callee.name === "styledSymbol") return "styledSymbol()";
		if (callee.name === "truncateToWidth") return "truncateToWidth()";
		if (callee.name === "visibleWidth") return "visibleWidth()";
		return undefined;
	}
	if (!t.isMemberExpression(callee)) return undefined;
	const property = memberName(callee);
	if (property === "paint") return ".paint()";
	if (property === "invalidate") return ".invalidate()";
	if (property === "requestRender") return "requestRender()";
	if (property === "requestComponentRender") return "requestComponentRender()";
	if (property === "styledSymbol") return "styledSymbol()";
	if (property === "truncateToWidth") return "truncateToWidth()";
	if (property === "visibleWidth") return "visibleWidth()";
	if (t.isIdentifier(callee.object, { name: "theme" }) && property === "fg") return "theme.fg()";
	if (t.isIdentifier(callee.object, { name: "theme" }) && property === "bg") return "theme.bg()";
	return undefined;
}

function directFunctionArgument(path: NodePath<t.Function>): NodePath<t.CallExpression> | undefined {
	if (!path.parentPath.isCallExpression()) return undefined;
	return path.parentPath.node.arguments.some(argument => argument === path.node) ? path.parentPath : undefined;
}

function eventAttribute(path: NodePath<t.Function>): NodePath<t.JSXAttribute> | undefined {
	if (!path.parentPath.isJSXExpressionContainer() || !path.parentPath.parentPath.isJSXAttribute()) return undefined;
	return path.parentPath.parentPath;
}

function eventProperty(path: NodePath<t.Function>): NodePath<t.ObjectProperty> | undefined {
	return path.parentPath.isObjectProperty() ? path.parentPath : undefined;
}

function addViolation(
	violations: Violation[],
	content: string,
	file: string,
	node: { readonly loc?: t.SourceLocation | null },
	rule: string,
): void {
	const line = node.loc?.start.line ?? 1;
	violations.push({ file, line, rule, source: sourceLine(content, line) });
}

/** Analyzes one parsed source file; exported for deterministic architecture-rule fixtures. */
export function analyzeArchitectureSource(content: string, options: AnalysisOptions): Violation[] {
	const plugins: ParserPlugin[] =
		options.file.endsWith(".tsx") || options.file.endsWith(".jsx")
			? ["typescript", "jsx", "importAttributes"]
			: ["typescript", "importAttributes"];
	const ast = parse(content, { sourceType: "unambiguous", plugins });
	const violations: Violation[] = [];
	const functions = new Map<t.Node, FunctionInfo>();
	const functionsByBinding = new Map<Binding, FunctionInfo>();
	const renderCallbackBindings = new Set<Binding>();
	const eventCallbackBindings = new Set<Binding>();
	const renderRootBindings = new Set<Binding>();
	const actionScopeBindings = new Set<Binding>();

	traverse(ast, {
		ImportDeclaration(path) {
			for (const specifier of path.node.specifiers) {
				if (
					!t.isImportSpecifier(specifier) ||
					!t.isIdentifier(specifier.imported) ||
					renderCallbacks[specifier.imported.name] !== true
				)
					continue;
				const binding = path.scope.getBinding(specifier.local.name);
				if (binding) renderCallbackBindings.add(binding);
			}
		},
		JSXAttribute(path) {
			if (!t.isJSXIdentifier(path.node.name) || !isEventOrActionName(path.node.name.name)) return;
			const expression = path.node.value;
			if (!t.isJSXExpressionContainer(expression) || !t.isIdentifier(expression.expression)) return;
			const binding = path.scope.getBinding(expression.expression.name);
			if (binding) eventCallbackBindings.add(binding);
		},
		ObjectProperty(path) {
			const name = t.isIdentifier(path.node.key)
				? path.node.key.name
				: t.isStringLiteral(path.node.key)
					? path.node.key.value
					: undefined;
			if (!name || !isEventOrActionName(name) || !t.isIdentifier(path.node.value)) return;
			const binding = path.scope.getBinding(path.node.value.name);
			if (binding) eventCallbackBindings.add(binding);
		},
	});

	traverse(ast, {
		ImportDeclaration(path) {
			if (!options.allowsDirectSolidImport && isDirectSolidImport(path))
				addViolation(violations, content, options.file, path.node, 'direct import from "solid-js"');
		},
		ClassDeclaration(path) {
			if (!options.isView || !path.node.implements?.some(implementsComponent)) return;
			addViolation(violations, content, options.file, path.node, "implements Component");
		},
		ClassExpression(path) {
			if (!options.isView || !path.node.implements?.some(implementsComponent)) return;
			addViolation(violations, content, options.file, path.node, "implements Component");
		},
		NewExpression(path) {
			if (options.isView && t.isIdentifier(path.node.callee, { name: "Mount" }))
				addViolation(violations, content, options.file, path.node, "new Mount");
		},
		VariableDeclarator(path) {
			if (
				!options.isView ||
				!options.file.endsWith(".tsx") ||
				!path.parentPath.isVariableDeclaration({ kind: "const" })
			)
				return;
			if (t.isObjectPattern(path.node.id) && t.isIdentifier(path.node.init, { name: "props" })) {
				addViolation(violations, content, options.file, path.node, "destructuring reactive props");
			}
		},
		Function(path) {
			const name = functionName(path);
			const info: FunctionInfo = {
				calls: new Set(),
				clocks: [],
				directRender: returnsJsx(path) || (name !== undefined && /^[A-Z]/u.test(name)),
				excluded: false,
				renders: false,
			};
			const binding = name ? functionBinding(path, name) : undefined;
			if (binding) functionsByBinding.set(binding, info);
			if (binding && eventCallbackBindings.has(binding)) info.excluded = true;
			if (isEventOrActionName(name ?? "")) info.excluded = true;
			const callback = directFunctionArgument(path);
			if (callback && isNamedCallback(callback.node.callee, renderCallbacks, renderCallbackBindings, callback))
				info.directRender = true;
			if (callback && isNamedCallback(callback.node.callee, actionCallbacks, undefined, callback))
				info.excluded = true;
			const event = eventAttribute(path);
			if (event && t.isJSXIdentifier(event.node.name) && isEventOrActionName(event.node.name.name))
				info.excluded = true;
			const property = eventProperty(path);
			if (property) {
				const propertyName = t.isIdentifier(property.node.key)
					? property.node.key.name
					: t.isStringLiteral(property.node.key)
						? property.node.key.value
						: undefined;
				if (propertyName && isEventOrActionName(propertyName)) info.excluded = true;
			}
			functions.set(path.node, info);
		},
		CallExpression(path) {
			if (options.isView) {
				const forbidden = isForbiddenCall(path.node);
				if (forbidden) addViolation(violations, content, options.file, path.node, forbidden);
			}
			if (t.isIdentifier(path.node.callee)) {
				const binding = path.scope.getBinding(path.node.callee.name);
				if (binding) {
					if (isNamedCallback(path.node.callee, renderCallbacks, renderCallbackBindings, path)) {
						for (const argument of path.node.arguments) {
							if (!t.isIdentifier(argument)) continue;
							const callback = path.scope.getBinding(argument.name);
							if (callback) renderRootBindings.add(callback);
						}
					}
					if (isNamedCallback(path.node.callee, actionCallbacks, undefined, path)) {
						for (const argument of path.node.arguments) {
							if (!t.isIdentifier(argument)) continue;
							const callback = path.scope.getBinding(argument.name);
							if (callback) actionScopeBindings.add(callback);
						}
					}
				}
			}
			const functionPath = path.findParent(parent => parent.isFunction());
			if (!functionPath) return;
			const info = functions.get(functionPath.node);
			if (!info) return;
			if (isDateNow(path.node)) info.clocks.push(path.node);
			if (!t.isIdentifier(path.node.callee)) return;
			const binding = path.scope.getBinding(path.node.callee.name);
			if (binding) info.calls.add(binding);
		},
	});

	for (const binding of renderRootBindings) {
		const target = functionsByBinding.get(binding);
		if (target) target.directRender = true;
	}
	for (const binding of actionScopeBindings) {
		const target = functionsByBinding.get(binding);
		if (target) target.excluded = true;
	}
	const pending = [...functions.values()].filter(info => info.directRender && !info.excluded);
	for (let cursor = 0; cursor < pending.length; cursor++) {
		const info = pending[cursor];
		if (info.renders) continue;
		info.renders = true;
		for (const binding of info.calls) {
			const target = functionsByBinding.get(binding);
			if (target && !target.excluded && !target.renders) pending.push(target);
		}
	}
	if (options.isView) {
		for (const info of functions.values()) {
			if (!info.renders) continue;
			for (const clock of info.clocks) addViolation(violations, content, options.file, clock, "Date.now()");
		}
	}
	for (const comment of ast.comments ?? []) {
		if (comment.type === "CommentBlock" && /^\*\s*@jsxImportSource\b/u.test(comment.value)) {
			addViolation(violations, content, options.file, comment, "legacy JSX import-source pragma");
		}
	}
	return violations;
}

function isAllowedSolidDirectory(file: string): boolean {
	return allowedSolidDirectories.some(directory => file.startsWith(resolve(packageRoot, "src", directory) + sep));
}

export async function checkArchitecture(): Promise<void> {
	const viewFiles = new Set((await Promise.all(viewDirectories.map(sourceFiles))).flat());
	const allFiles = [...new Set((await Promise.all(sourceDirectories.map(sourceFiles))).flat())].sort();
	const violations: Violation[] = [];
	let legacyFiles = 0;

	for (const absoluteFile of allFiles) {
		const content = await readFile(absoluteFile, "utf8");
		const file = normalized(relative(repositoryRoot, absoluteFile));
		const fileViolations = analyzeArchitectureSource(content, {
			file,
			isView: viewFiles.has(absoluteFile),
			allowsDirectSolidImport: isAllowedSolidDirectory(absoluteFile),
		});
		violations.push(...fileViolations);
		legacyFiles += fileViolations.filter(violation => violation.rule === "legacy JSX import-source pragma").length;
	}

	for (const violation of violations)
		console.error(`${violation.file}:${violation.line}: ${violation.rule}: ${violation.source}`);
	if (violations.length > 0) {
		console.error(
			`Architecture check failed (strict): ${violations.length} violation(s) in ${allFiles.length} source file(s).`,
		);
		process.exitCode = 1;
		return;
	}
	console.log(
		`Architecture check passed (strict): ${allFiles.length} source file(s), 0 violations; ${legacyFiles} legacy file(s).`,
	);
}

if (import.meta.main) await checkArchitecture();
