const solidInternalRuntimeFilter = /[\\/]solid-js[\\/](?:store|universal)[\\/]dist[\\/][^\\/]+\.js$/;

/** Bare Solid specifiers controlled by the TUI compiler. */
export type SolidRuntimeSpecifier = "solid-js" | "solid-js/store" | "solid-js/universal";

/** Resolve a bare Solid specifier to its reactive distribution file. */
export function resolveSolidRuntime(specifier: SolidRuntimeSpecifier): string {
	switch (specifier) {
		case "solid-js":
			return Bun.resolveSync("solid-js/dist/solid.js", import.meta.dir);
		case "solid-js/store":
			return Bun.resolveSync("solid-js/store/dist/store.js", import.meta.dir);
		case "solid-js/universal":
			return Bun.resolveSync("solid-js/universal/dist/universal.js", import.meta.dir);
	}
}

/** Rewrite a Solid subpackage's internal core import to the selected reactive runtime. */
export function rewriteSolidCoreImports(source: string): string {
	const runtimeSpecifier = JSON.stringify(resolveSolidRuntime("solid-js"));
	return source.replaceAll('"solid-js"', runtimeSpecifier).replaceAll("'solid-js'", runtimeSpecifier);
}

/** Install deterministic Solid resolution and internal-runtime rewriting on a Bun plugin builder. */
export function installSolidResolution(build: Bun.PluginBuilder): void {
	build.onResolve({ filter: /^solid-js\/web$/ }, () => {
		throw new Error(
			'solid-js/web is the DOM renderer and is not supported by @oh-my-pi/pi-tui; import from "@oh-my-pi/pi-tui/reactive" instead',
		);
	});
	build.onResolve({ filter: /^solid-js$/ }, () => ({
		path: resolveSolidRuntime("solid-js"),
	}));
	build.onResolve({ filter: /^solid-js\/store$/ }, () => ({
		path: resolveSolidRuntime("solid-js/store"),
	}));
	build.onResolve({ filter: /^solid-js\/universal$/ }, () => ({
		path: resolveSolidRuntime("solid-js/universal"),
	}));
	build.onLoad({ filter: solidInternalRuntimeFilter }, async ({ path }) => ({
		contents: rewriteSolidCoreImports(await Bun.file(path).text()),
		loader: "js",
	}));
}
