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

const DEFAULT_FILTER = /\.[cm]?[jt]sx?$/;
const NEEDLE = "import.meta.console";

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
				const source = await Bun.file(path).text();

				// Cheap bail-out: skip Babel entirely for files that can't
				// possibly contain the needle.
				//
				// We can't `return undefined` here: a global plugin registered
				// via `preload` runs for the whole module graph, and when its
				// `onLoad` hook returns `undefined` Bun (≥1.3) treats it as a
				// module-mock that produced nothing and throws "Expected module
				// mock to return an object". Returning the untouched source with
				// the matching loader lets Bun load the file normally.
				if (!source.includes(NEEDLE)) {
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
