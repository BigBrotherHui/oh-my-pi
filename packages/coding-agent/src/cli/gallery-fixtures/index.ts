/**
 * Aggregated sample data for the `omp gallery` command.
 *
 * Each fixture drives one tool's renderer through the four lifecycle states the
 * gallery showcases: arguments streaming in, arguments complete but awaiting a
 * result, a successful result, and a failed result. The data is intentionally
 * hand-written (rather than schema-derived) so the gallery reflects what a real
 * tool call looks like — the whole point is visual QA of the renderers.
 *
 * Fixtures are grouped by subsystem into sibling modules and merged here.
 * Adding a tool to one of those groups is enough for the gallery to render it.
 * Minimal public-tool scenarios use createFallbackGalleryFixture. Internal
 * renderer aliases are not separate user-facing gallery entries.
 */
import { agenticFixtures } from "./agentic";
import { codeintelFixtures } from "./codeintel";
import { editFixtures } from "./edit";
import { fsFixtures } from "./fs";
import { interactionFixtures } from "./interaction";
import { memoryFixtures } from "./memory";
import { miscFixtures } from "./misc";
import { searchFixtures } from "./search";
import { shellFixtures } from "./shell";
import { statusLineFixtures } from "./status-line";
import { webFixtures } from "./web";
import type { GalleryFixture } from "./types";

/** Build a minimal public-tool sample when no richer scenario is available. */
export function createFallbackGalleryFixture(name: string): GalleryFixture {
	return {
		args: { note: `sample ${name} call` },
		result: { content: [{ type: "text", text: `${name} completed` }] },
	};
}

export * from "./composer";
export * from "./segments";
export * from "./types";

export const galleryFixtures = {
	...Object.fromEntries(
		["hub", "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"].map(name => [
			name,
			createFallbackGalleryFixture(name),
		]),
	),
	...interactionFixtures,
	...shellFixtures,
	...fsFixtures,
	...searchFixtures,
	...editFixtures,
	...agenticFixtures,
	...memoryFixtures,
	...webFixtures,
	...codeintelFixtures,
	...statusLineFixtures,
	...miscFixtures,
};
