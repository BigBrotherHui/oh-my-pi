import { solidJsxPlugin } from "./solid-jsx-plugin";

let registered = false;

/** Register the shared Solid TSX compiler once in the current Bun process. */
export function register(): void {
	if (registered) return;
	Bun.plugin(solidJsxPlugin);
	registered = true;
}

register();
