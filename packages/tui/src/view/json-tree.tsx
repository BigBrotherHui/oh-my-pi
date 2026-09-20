import type { JSX } from "../reactive";
import type { JsonProps, JsonResult } from "../host/elements/json";

/** Props for the shared JSON tree composition. */
export type JsonTreeProps = JsonProps;

/** JSON projection result reported after painting. */
export type JsonTreeResult = JsonResult;

/** Delegate structured JSON layout and truncation to the json host element. */
export function JsonTree(props: JsonTreeProps): JSX.Element {
	return <json {...props} />;
}
