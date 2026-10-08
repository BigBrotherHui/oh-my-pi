import { prompt } from "@oh-my-pi/pi-utils";
import toolCallBudgetWrapUpTemplate from "../prompts/system/tool-call-budget-wrapup.md" with { type: "text" };

export const TOOL_CALL_BUDGET_WRAPUP_TYPE = "tool-call-budget-wrapup";

export interface ToolCallBudgetWrapUpDetails {
	count: number;
	budget: number;
}

/**
 * The text injected once an agent run has spent its tool-call budget. Shared by
 * the near-budget reminder and the hard stop so both say the same thing.
 */
export function renderToolCallBudgetWrapUp(details: ToolCallBudgetWrapUpDetails): string {
	return prompt.render(toolCallBudgetWrapUpTemplate, {
		count: details.count,
		budget: details.budget,
	});
}
