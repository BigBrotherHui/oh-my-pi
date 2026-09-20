/** Babel plugins without published declarations, consumed by `@oh-my-pi/pi-tui/compiler`. */
declare module "@babel/plugin-transform-typescript" {
	import type { PluginObj } from "@babel/core";
	const plugin: (api: unknown, options?: Record<string, unknown>) => PluginObj;
	export default plugin;
}
declare module "babel-plugin-jsx-dom-expressions" {
	import type { PluginObj } from "@babel/core";
	const plugin: (api: unknown, options?: Record<string, unknown>) => PluginObj;
	export default plugin;
}
