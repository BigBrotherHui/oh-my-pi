import { sanitizeText as sanitizeStatusText } from "@oh-my-pi/pi-utils";

/** A `/loop --while` / `/loop --until` continue-condition. */
export interface LoopConditionConfig {
	/** Shell command line, run through the user's configured shell. */
	command: string;
	/** `--until`: continue while the command *fails*. `--while`: while it succeeds. */
	until: boolean;
}

export type LoopLimitRuntime =
	| {
			kind: "iterations";
			initial: number;
			remaining: number;
	  }
	| {
			kind: "duration";
			durationMs: number;
			deadlineMs: number;
	  };

/** Compact status-line form: `until: bun test`. */
export function summarizeLoopCondition(condition: LoopConditionConfig): string {
	return `${condition.until ? "until" : "while"}: ${sanitizeStatusText(condition.command)}`;
}
