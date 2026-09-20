import type { JSX as SolidJSX } from "./reactive";
import type { TuiIntrinsicElements } from "./host/intrinsics";

/** Type-only JSX namespace for the retained terminal host vocabulary. */
export namespace JSX {
	export type Element = SolidJSX.Element;
	export type ElementClass = SolidJSX.ElementClass;
	export type ElementAttributesProperty = SolidJSX.ElementAttributesProperty;
	export type ElementChildrenAttribute = SolidJSX.ElementChildrenAttribute;
	export type IntrinsicAttributes = SolidJSX.IntrinsicAttributes;
	export type CustomAttributes<T> = SolidJSX.CustomAttributes<T>;
	export interface IntrinsicElements extends TuiIntrinsicElements {}
}
