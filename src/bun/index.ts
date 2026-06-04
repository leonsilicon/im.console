/**
 * Bun plugin: applies the `import.meta.console` transform to every module Bun
 * loads, so that `bun file.ts` rewrites `import.meta.console.*` calls in the
 * entry file *and* in every file it imports.
 *
 * Bun's plugin `onLoad` hook fires for each module as it's loaded. When the
 * plugin is registered through a preload script (`bunfig.toml` `preload`), the
 * hook applies to the whole module graph — not just the entry — which is what
 * makes the imported-file case work.
 *
 * Usage (bunfig.toml) — the zero-config side-effect entry:
 *
 *   preload = ["im.console/bun/preload"]
 *
 * or programmatically in your own preload module:
 *
 *   import { imConsolePlugin } from 'im.console/bun';
 *   Bun.plugin(imConsolePlugin());
 *
 * The transform itself is the shared Babel plugin, run on-the-fly here rather
 * than ahead of time.
 */
import { transformSync, type ParserOptions } from "@babel/core";
import babelPlugin, { type PluginOptions } from "../plugin/index.ts";

// Element type of `parserOpts.plugins`, derived from Babel's own typings so we
// don't take a direct dependency on `@babel/parser`.
type ParserPlugin = NonNullable<ParserOptions["plugins"]>[number];

// `BunPlugin` / `OnLoadResultObject` live in the global `Bun` namespace
// (from `@types/bun`). Referencing them there avoids the dts bundler tripping
// over named re-exports from the `'bun'` module.
type BunPlugin = Bun.BunPlugin;
type Loader = Bun.OnLoadResultSourceCode["loader"];

// Babel lazily `require()`s some helpers (e.g. `@babel/helper-compilation-
// targets`) the first time `transformSync` runs. Bun forbids a synchronous
// `require()` of a not-yet-loaded module from inside an `onLoad` hook, so we
// warm those modules' require caches up front — while we're still at the
// (async-safe) top level — by running one throwaway transform.
let warmed = false;
const warmBabel = (): void => {
	if (warmed) {
		return;
	}
	warmed = true;
	try {
		transformSync("const _imConsoleWarmup = 1;", {
			filename: "warmup.ts",
			configFile: false,
			babelrc: false,
			browserslistConfigFile: false,
			// Match the real transform so the same lazy requires (source-map
			// generation helpers) are warmed.
			sourceMaps: "inline",
			parserOpts: {
				sourceType: "module",
				plugins: ["typescript"],
			},
		});
	} catch {
		// Best-effort: if the warmup itself fails, the real transform will
		// surface the error with proper context.
	}
};

export type BunPluginOptions = {
	/** Module specifier the rewritten code imports the runtime from. Defaults
	 *  to `'im.console/runtime'`. */
	runtimeSpecifier?: string;

	/** Glob-ish filter for which files to transform. Defaults to all
	 *  JS/TS source files. */
	filter?: RegExp;
};

// Match JS/TS source files but never anything under `node_modules`.
//
// This exclusion is load-bearing: Bun (≥1.3, see oven-sh/bun#5044) mis-detects a
// CommonJS module as ESM whenever an `onLoad` hook returns `contents` for it,
// producing errors like `SyntaxError: Missing 'default' export in module ...`.
// We can't dodge that by returning `undefined` from the hook either — for a
// global plugin registered via `preload`, Bun treats an `undefined` return as a
// failed module mock and throws `Expected module mock to return an object`.
//
// Since the hook is forced to return `contents` for every file it matches, the
// only safe move is to never match the files we don't transform. Virtually all
// CommonJS in a real project lives in `node_modules`, so excluding it lets Bun
// load dependencies natively while we still transform first-party source.
const DEFAULT_FILTER = /^(?:(?!node_modules).)*\.[cm]?[jt]sx?$/;
const NEEDLE = "import.meta.console";

// Heuristic CommonJS detector for first-party files. A source file that uses
// `module.exports`/`exports.foo` and has no top-level `import`/`export` would be
// broken by the bun#5044 bug if we re-emitted its contents, so we leave it
// alone. (It also can't contain `import.meta.console`, so there is nothing to
// transform.)
const looksLikeCjs = (source: string): boolean =>
	/\bmodule\.exports\b|(?:^|[^.\w$])exports\.[\w$]/.test(source) &&
	!/^\s*(?:import|export)\b/m.test(source);

/** Map a file extension to the Bun loader that should parse the transform
 *  output. Babel strips TS/JSX syntax, but keeping the matching loader is
 *  harmless and future-proofs files that mix syntaxes. */
const loaderFor = (path: string): Loader => {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) {
		return "ts";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	return "js";
};

const parserPluginsFor = (path: string): ParserPlugin[] => {
	const plugins: ParserPlugin[] = [];
	if (
		path.endsWith(".ts") ||
		path.endsWith(".mts") ||
		path.endsWith(".cts") ||
		path.endsWith(".tsx")
	) {
		plugins.push("typescript");
	}
	if (path.endsWith("x")) {
		plugins.push("jsx");
	}
	return plugins;
};

export const imConsolePlugin = (options: BunPluginOptions = {}): BunPlugin => {
	const filter = options.filter ?? DEFAULT_FILTER;
	const pluginOptions: PluginOptions = {
		// Bun always loads ESM, so emit an `import` for the runtime.
		module: "esm",
		...(options.runtimeSpecifier === undefined
			? {}
			: { runtimeSpecifier: options.runtimeSpecifier }),
	};

	return {
		name: "im.console",
		setup(build): void {
			warmBabel();
			build.onLoad({ filter }, async ({ path }) => {
				// Defensive guard for a custom `filter` that doesn't exclude
				// dependencies: never re-emit anything under `node_modules`, so
				// Bun loads them natively and the bun#5044 CJS breakage can't
				// reach third-party code. Returning `undefined` is fine here —
				// dependency files never hold the needle, so this is the same
				// no-op path as a non-needle bail-out.
				if (path.includes("/node_modules/")) {
					return undefined;
				}

				const source = await Bun.file(path).text();

				// Bail-out for files that can't contain the needle. We can't
				// `return undefined` here: for a global plugin registered via
				// `preload`, Bun treats an `undefined` return as a failed module
				// mock and throws "Expected module mock to return an object". So
				// instead we re-emit the untouched source with the matching
				// loader and let Bun parse it.
				//
				// The one shape Bun mishandles is a CommonJS module re-emitted
				// through `onLoad` (oven-sh/bun#5044 — it gets parsed as ESM and
				// loses its exports). A CJS file can't hold `import.meta.console`
				// anyway, so we skip re-emitting it: returning `undefined` for a
				// non-needle CJS file is the lesser evil — it only triggers the
				// "module mock" throw in the (rare) case of a first-party CJS
				// source file, whereas re-emitting it would silently corrupt its
				// exports. `node_modules` (where realistically all CJS lives) is
				// already excluded by the default filter.
				if (!source.includes(NEEDLE)) {
					if (looksLikeCjs(source)) {
						return undefined;
					}
					return {
						contents: source,
						loader: loaderFor(path),
					};
				}

				const result = transformSync(source, {
					filename: path,
					configFile: false,
					babelrc: false,
					browserslistConfigFile: false,
					sourceMaps: "inline",
					parserOpts: {
						sourceType: "module",
						plugins: parserPluginsFor(path),
					},
					plugins: [[babelPlugin, pluginOptions]],
				});

				// Fall back to the original source (not `undefined`) for the same
				// reason as above.
				const code = result?.code ?? source;

				return {
					contents: code,
					loader: loaderFor(path),
				};
			});
		},
	};
};

export default imConsolePlugin;
