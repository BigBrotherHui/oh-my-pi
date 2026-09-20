/**
 * Regression: fire-and-forget async IIFEs in StatusLineComponent
 * (`#isDefaultBranch`, `#lookupPr`) outlive `dispose()`. After tests call
 * `resetSettingsForTest()`, a late update must not read reset settings.
 *
 * Contract: after `dispose()`, awaited git/gh work cannot publish a revision,
 * even when it resolves later. The tests force the race deterministically by
 * delaying `VcsGitRepo.defaultBranch` and the PR lookup.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-tui/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { StatusLineTestComponents, renderStatusLine } from "./helpers/status-line";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

beforeEach(() => {
	headState = fakeRefHead;
	defaultBranchMock = vi.fn(async () => null);
	vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
	const gitRepository = {
		defaultBranch: defaultBranchMock,
		headSync: () => headState,
		linkedWorktree: () => null,
	} as unknown as VcsGitRepo;
	vi.spyOn(vcs, "git").mockReturnValue(gitRepository);
	const repository = {
		kind: () => "git",
		asGit: () => gitRepository,
		asJj: () => null,
		root: () => fakeRepoInfo.repoRoot,
		watchTarget: () => fakeRepoInfo.headPath,
	} as unknown as VcsRepo;
	vi.spyOn(vcs, "repo").mockReturnValue(repository);
	// The render path resolves the branch through the display detector first;
	// left unstubbed it finds the real checkout and caches its branch.
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(repository);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "dispose-leak test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

const fakeRefHead: VcsHeadState = {
	kind: "ref",
	branch: "main",
	refName: "refs/heads/main",
	commit: undefined,
};
const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	isReftable: false,
};
const featureRefHead: VcsHeadState = {
	kind: "ref",
	branch: "feature/x",
	refName: "refs/heads/feature/x",
	commit: undefined,
};
let headState = fakeRefHead;

let defaultBranchMock = vi.fn(async (): Promise<string | null> => null);

const gitSegmentSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pr"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

describe("StatusLineComponent dispose guards async callbacks", () => {
	it("does not publish after VcsGitRepo.defaultBranch resolves post-disposal", async () => {
		// #isDefaultBranch seeds #defaultBranch = "main" synchronously. The
		// fake HEAD is on "main", so #isDefaultBranch("main") returns true
		// and #lookupPr short-circuits without spawning `gh pr view` — but
		// the VcsGitRepo.defaultBranch IIFE still starts (it fires whenever
		// #defaultBranch is undefined, regardless of the sync result). Delay
		// it past dispose so the guard is the only thing preventing the
		// callback.
		let resolveDefault: ((v: string | null) => void) | undefined;
		defaultBranchMock.mockImplementation(() => new Promise<string | null>(r => (resolveDefault = r)));

		const component = new StatusLineComponent(makeSession(), statusLineHost);
		component.updateSettings(gitSegmentSettings);

		// Render with a `pr` segment → #lookupPr → #isDefaultBranch("main")
		// → starts the delayed git.branch.default IIFE (no gh spawn: the
		// sync default-branch check returns true and PR lookup bails).
		renderStatusLine(component, 80);
		expect(resolveDefault).toBeDefined();

		// Tear down the component before the awaited promise resolves.
		component.dispose();
		const revision = component.revision();

		// Release the delayed lookup.
		resolveDefault!("develop");
		await Promise.resolve();
		await Promise.resolve();

		expect(component.revision()).toBe(revision);
	});

	it("does not publish from an already-queued default-branch resolution after disposal", async () => {
		// Same guard, but the awaited promise resolves synchronously before
		// dispose; the queued microtask must still be suppressed by the
		// disposed flag checked inside the IIFE continuation.
		defaultBranchMock.mockResolvedValue("develop");

		const component = new StatusLineComponent(makeSession(), statusLineHost);
		component.updateSettings(gitSegmentSettings);

		renderStatusLine(component, 80);

		// Dispose before the resolved-promise microtask gets a chance to run.
		component.dispose();
		const revision = component.revision();

		await Promise.resolve();
		await Promise.resolve();

		expect(component.revision()).toBe(revision);
	});

	it("suppresses a pending PR lookup when tracked file teardown resets settings", async () => {
		headState = featureRefHead;
		defaultBranchMock.mockResolvedValue("main");
		const ghStarted = Promise.withResolvers<void>();
		const releaseGh = Promise.withResolvers<void>();
		vi.spyOn(github, "run").mockImplementation(async () => {
			ghStarted.resolve();
			await releaseGh.promise;
			return { exitCode: 1, stdout: "", stderr: "" };
		});

		const components = new StatusLineTestComponents();
		const component = components.track(new StatusLineComponent(makeSession(), statusLineHost));
		component.updateSettings(gitSegmentSettings);

		renderStatusLine(component, 80);
		await ghStarted.promise;

		components.dispose();
		const revision = component.revision();
		resetSettingsForTest();
		releaseGh.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(component.revision()).toBe(revision);
		await Settings.init({ inMemory: true });
	});
});
