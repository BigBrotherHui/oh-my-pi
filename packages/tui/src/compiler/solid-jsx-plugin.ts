import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Babel from "@babel/core";
import type TransformTypeScript from "@babel/plugin-transform-typescript";
import { getSolidTsxCacheDbPath } from "@oh-my-pi/pi-utils/dirs";
import type JsxDomExpressions from "babel-plugin-jsx-dom-expressions";
import type { BunPlugin } from "bun";
import { installSolidResolution, resolveSolidRuntime, type SolidRuntimeSpecifier } from "./solid-resolve";

const rendererModule = "@oh-my-pi/pi-tui/host/renderer";
const excludedPath =
	/(?:^|\/)packages\/collab-web(?:\/|$)|(?:^|\/)python(?:\/|$)|(?:^|\/)node_modules\/(?!@oh-my-pi(?:\/|$))/;
const solidTsxLoadFilter =
	/^(?!.*[\\/]packages[\\/]collab-web[\\/])(?!.*[\\/]python[\\/])(?!.*[\\/]node_modules[\\/](?!@oh-my-pi[\\/])).*\.tsx(?:\?(?!mtime=).*)?$/;
const registerPath = fileURLToPath(new URL("./register.ts", import.meta.url));

const TSX_CACHE_SCHEMA_VERSION = 1;
const CREATE_TSX_CACHE_TABLE =
	"CREATE TABLE IF NOT EXISTS solid_tsx_cache (cache_key TEXT PRIMARY KEY, code TEXT NOT NULL)";
/** One checkout compiles to ~12 MB (inline source maps); leave room for several worktrees and compiler versions. */
const TSX_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const TSX_CACHE_MAX_ENTRIES = 5_000;

interface DiskCache {
	readonly select: Statement<{ code: string }, [string]>;
	readonly insert: Statement<void, [string, string]>;
	readonly count: Statement<{ count: number }, []>;
	readonly clear: Statement<void, []>;
	/** Hash of every input that changes the transform output besides the source itself. */
	readonly salt: string;
}

let diskCache: DiskCache | null | undefined;

/**
 * Open the persistent compile cache (`~/.omp/cache/solid-tsx-cache.db`), shared
 * by every omp process on the machine. Babel compiles ~70k lines of TSX per
 * cold start, which dominated CLI startup before this cache existed; a hit is
 * one indexed row read. Everything here is synchronous so a cache hit can be
 * served without a promise, which lets Bun `require()` TSX modules.
 *
 * Mirrors the legacy Pi extension parse cache: busy handler before any
 * lock-taking pragma, WAL + `synchronous=NORMAL` so concurrent startups do not
 * serialize on journal fsyncs, `user_version` gating the schema, and full WAL-set
 * removal when the file outgrows its budget (a leftover `-wal` owned by another
 * process fails `journal_mode=WAL` with SQLITE_IOERR, see #9549). The shared
 * `pi-utils/sqlite` opener is off limits here: this module is a Bun preload and
 * that opener imports `pi-utils/env`, which reads the agent dir's `.env` before
 * `setProfile` has run.
 *
 * The salt folds in this plugin's source (the transform options live here), the
 * resolved jsx-dom-expressions entry (patched in this repo, so its version alone
 * cannot detect changes) and the Babel package versions. Any failure — e.g. a
 * compiled binary where nothing resolves on disk — disables caching.
 */
function openDiskCache(): DiskCache | null {
	if (diskCache !== undefined) return diskCache;
	try {
		const jsxEntry = Bun.resolveSync("babel-plugin-jsx-dom-expressions", import.meta.dir);
		const salt = Bun.hash(
			[
				fs.readFileSync(import.meta.path, "utf8"),
				fs.readFileSync(jsxEntry, "utf8"),
				packageVersion("@babel/core/package.json"),
				packageVersion("@babel/plugin-transform-typescript/package.json"),
			].join("\0"),
		).toString(16);
		const db = openCacheDb(getSolidTsxCacheDbPath());
		diskCache = {
			select: db.query("SELECT code FROM solid_tsx_cache WHERE cache_key = ?"),
			insert: db.query("INSERT OR REPLACE INTO solid_tsx_cache (cache_key, code) VALUES (?, ?)"),
			count: db.query("SELECT count(*) AS count FROM solid_tsx_cache"),
			clear: db.query("DELETE FROM solid_tsx_cache"),
			salt,
		};
	} catch {
		diskCache = null;
	}
	return diskCache;
}

function packageVersion(specifier: string): string {
	const manifest: { version: string } = JSON.parse(
		fs.readFileSync(Bun.resolveSync(specifier, import.meta.dir), "utf8"),
	);
	return manifest.version;
}

function openCacheDb(dbPath: string): Database {
	try {
		if (fs.statSync(dbPath).size > TSX_CACHE_MAX_BYTES) {
			for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${dbPath}${suffix}`, { force: true });
		}
	} catch {
		// A missing or unreadable cache is a cold cache.
	}
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	// Interactive-host busy budget; `getDbBusyTimeoutMs` lives in `pi-utils/env`.
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode=WAL");
	db.run("PRAGMA synchronous=NORMAL");
	const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
	if (version === TSX_CACHE_SCHEMA_VERSION) {
		db.run(CREATE_TSX_CACHE_TABLE);
	} else {
		db.transaction(() => {
			db.run("DROP TABLE IF EXISTS solid_tsx_cache");
			db.run(CREATE_TSX_CACHE_TABLE);
			db.run(`PRAGMA user_version = ${TSX_CACHE_SCHEMA_VERSION}`);
		})();
	}
	return db;
}

function diskCacheKey(disk: DiskCache, path: string, source: string): string {
	return `${disk.salt}:${Bun.hash(`${path}\0${source}`).toString(16)}`;
}

/** Best-effort read: a busy or corrupt cache falls through to a recompile. */
function readDiskCache(disk: DiskCache, cacheKey: string): string | undefined {
	try {
		return disk.select.get(cacheKey)?.code;
	} catch {
		return undefined;
	}
}

/** Best-effort write: a busy or read-only cache only costs the next process a recompile. */
function writeDiskCache(disk: DiskCache, cacheKey: string, code: string): void {
	try {
		disk.insert.run(cacheKey, code);
		if ((disk.count.get()?.count ?? 0) > TSX_CACHE_MAX_ENTRIES) disk.clear.run();
	} catch {}
}

interface BabelCompilerModules {
	readonly babel: typeof Babel;
	readonly transformTypeScript: typeof TransformTypeScript;
	readonly jsxDomExpressions: typeof JsxDomExpressions;
}

let babelCompilerPromise: Promise<BabelCompilerModules> | undefined;

/**
 * Load Babel only when a TSX onLoad actually needs it. The shared compiler is
 * preloaded for every CLI process, so eager imports would evaluate Babel's
 * traverse/types CommonJS closure during ordinary startup.
 */
function loadBabelCompiler(): Promise<BabelCompilerModules> {
	if (babelCompilerPromise) return babelCompilerPromise;
	const compilerPromise = Promise.all([
		import("@babel/core"),
		import("@babel/plugin-transform-typescript"),
		import("babel-plugin-jsx-dom-expressions"),
	]).then(([babel, transformTypeScript, jsxDomExpressions]) => ({
		babel,
		transformTypeScript: transformTypeScript.default,
		jsxDomExpressions: jsxDomExpressions.default,
	}));
	babelCompilerPromise = compilerPromise;
	return compilerPromise;
}

function solidImportPath(specifier: string, path: string): string | undefined {
	if (specifier === "solid-js/web") {
		throw new Error(
			`solid-js/web is the DOM renderer and is not supported in ${path}; import from "@oh-my-pi/pi-tui/reactive" instead`,
		);
	}
	if (specifier !== "solid-js" && specifier !== "solid-js/store" && specifier !== "solid-js/universal") {
		return undefined;
	}
	return resolveSolidRuntime(specifier satisfies SolidRuntimeSpecifier);
}

function forceSolidReactiveImports(path: string): Babel.PluginObj {
	return {
		name: "pi-tui-force-solid-reactive-imports",
		visitor: {
			ImportDeclaration(importPath) {
				const replacement = solidImportPath(importPath.node.source.value, path);
				if (replacement) importPath.node.source.value = replacement;
			},
			ExportNamedDeclaration(exportPath) {
				if (!exportPath.node.source) return;
				const replacement = solidImportPath(exportPath.node.source.value, path);
				if (replacement) exportPath.node.source.value = replacement;
			},
			ExportAllDeclaration(exportPath) {
				const replacement = solidImportPath(exportPath.node.source.value, path);
				if (replacement) exportPath.node.source.value = replacement;
			},
		},
	};
}

/** Return whether a source path belongs to the Solid TSX compilation scope. */
export function isSolidTsxPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/").replace(/\?.*$/, "");
	return normalized.endsWith(".tsx") && !excludedPath.test(normalized);
}

/** Return whether TSX source belongs to the retained universal renderer. */
export function shouldTransformSolidTsx(_source: string, path: string): boolean {
	return isSolidTsxPath(path);
}

/**
 * Return the cached compile of a TSX module without touching Babel, or
 * `undefined` on a miss. Sources outside the Solid scope come back verbatim.
 */
export function transformCached(source: string, path: string): string | undefined {
	if (!shouldTransformSolidTsx(source, path)) return source;
	const disk = openDiskCache();
	return disk ? readDiskCache(disk, diskCacheKey(disk, path, source)) : undefined;
}

/** Compile one TSX module to Solid's universal renderer calls. */
export async function transform(source: string, path: string): Promise<string> {
	const cached = transformCached(source, path);
	if (cached !== undefined) return cached;

	const { babel, transformTypeScript, jsxDomExpressions } = await loadBabelCompiler();
	const result = babel.transformSync(source, {
		babelrc: false,
		configFile: false,
		filename: path,
		parserOpts: {
			plugins: ["typescript", "jsx"],
			sourceType: "module",
		},
		plugins: [
			forceSolidReactiveImports(path),
			[
				transformTypeScript,
				{
					allowDeclareFields: true,
					isTSX: true,
					onlyRemoveTypeImports: true,
				},
			],
			[
				jsxDomExpressions,
				{
					builtIns: [],
					generate: "universal",
					moduleName: rendererModule,
				},
			],
		],
		retainLines: true,
		sourceFileName: path,
		sourceMaps: "inline",
	});
	if (!result?.code) throw new Error(`Babel emitted no code for ${path}`);
	const disk = openDiskCache();
	if (disk) writeDiskCache(disk, diskCacheKey(disk, path, source), result.code);
	return result.code;
}

/** Read and transform a TSX file. */
export function transformFile(path: string): Promise<string> {
	return transform(fs.readFileSync(path, "utf8"), path);
}

/** Bun runtime/build plugin for Solid TSX and the browser-reactive Solid distributions. */
export const solidJsxPlugin: BunPlugin = {
	name: "pi-tui-solid-universal-jsx",
	target: "bun",
	setup(build) {
		installSolidResolution(build);
		// Cache hits are answered synchronously (no promise) so `require()` can
		// reach TSX modules; only a Babel recompile goes async.
		build.onLoad({ filter: solidTsxLoadFilter }, ({ path }) => {
			const source = fs.readFileSync(path.replace(/\?.*$/, ""), "utf8");
			const cached = transformCached(source, path);
			if (cached !== undefined) return { contents: cached, loader: "js" };
			return transform(source, path).then(contents => ({ contents, loader: "js" }));
		});
	},
};

/**
 * Create a build plugin that evaluates the runtime compiler registration before an entrypoint.
 *
 * The import is injected into the entry module itself, never via a wrapper
 * entry: Bun folds `import.meta.main` to `false` in every non-entry module, so
 * wrapping silently disabled the `if (import.meta.main)` launch guard in
 * `cli.ts` and the npm `dist/cli.js` exited without running. Appending keeps
 * the entry's line numbers intact; ESM hoisting still evaluates the
 * registration before the entry body runs.
 */
export function createSolidJsxEntrypointPlugin(entrypoint: string): BunPlugin {
	const absoluteEntrypoint = fs.realpathSync(path.resolve(entrypoint));
	const registration = `\nimport ${JSON.stringify(registerPath)};\n`;
	return {
		name: "pi-tui-solid-runtime-entrypoint",
		target: "bun",
		setup(build) {
			const present = build.config.entrypoints.some(candidate => {
				try {
					return fs.realpathSync(path.resolve(candidate)) === absoluteEntrypoint;
				} catch {
					return false;
				}
			});
			if (!present) throw new Error(`Solid runtime entrypoint is not in this build: ${absoluteEntrypoint}`);
			build.onLoad({ filter: new RegExp(`^${RegExp.escape(absoluteEntrypoint)}$`) }, async ({ path: entryPath }) => {
				if (isSolidTsxPath(entryPath)) {
					return { contents: registration + (await transformFile(entryPath)), loader: "js" };
				}
				return { contents: (await Bun.file(entryPath).text()) + registration, loader: "ts" };
			});
		},
	};
}
