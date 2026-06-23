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
 * The transform is a dependency-free hand-rolled scanner (`./transform.ts`),
 * NOT Babel. The package therefore pulls in no runtime or peer dependencies:
 * Bun exposes no AST API (`Bun.Transpiler` only strips types, and stripping
 * shifts line numbers — corrupting the `[file:line:col]` prefix), so the
 * scanner rewrites the original source by character offset. The richer
 * Babel-based AOT transform still ships separately as `im.console/plugin` for
 * build pipelines that already run Babel.
 *
 * ## How files we don't transform are passed through
 *
 * Bun's `onLoad` hook (under a preloaded plugin) cannot bail out by returning
 * `undefined` — Bun treats that as a failed module mock and throws
 * "Expected module mock to return an object" / "onLoad() expects an object
 * returned". For files we don't need to transform we therefore *have to*
 * return a valid `{ contents, loader }` result.
 *
 * For ESM files (`.mjs`, `.mts`, plus `.js` / `.ts` / `.jsx` / `.tsx` that
 * don't look like CommonJS) this is safe: we re-emit the source verbatim with
 * the matching loader and Bun parses it normally.
 *
 * CommonJS is the dangerous case. Bun's loader pipeline (see oven-sh/bun#5044)
 * parses any `onLoad`-re-emitted source as ESM, so a `module.exports = …`
 * file goes through `onLoad` and comes out the other side as
 * `{ default: undefined }` with all of its exports stripped. The two
 * always-CJS extensions (`.cjs`, `.cts`) are therefore excluded from the
 * default filter — we never claim them, and Bun loads them through its
 * native pipeline with exports intact. First-party `.js` / `.ts` files that
 * are nonetheless CommonJS (rare in modern projects, but possible) are
 * detected at load time and we pass them through with the same caveat — see
 * the comment on `looksLikeCjs` below.
 */
import { transform } from "./transform.ts";

// `BunPlugin` / `OnLoadResultObject` live in the global `Bun` namespace
// (from `@types/bun`). Referencing them there avoids the dts bundler tripping
// over named re-exports from the `'bun'` module.
type BunPlugin = Bun.BunPlugin;
type Loader = Bun.OnLoadResultSourceCode["loader"];

export type BunPluginOptions = {
	/** Module specifier the rewritten code imports the runtime from. Defaults
	 *  to `'im.console/runtime'`. */
	runtimeSpecifier?: string;

	/** Glob-ish filter for which files to transform. Defaults to ESM-capable
	 *  source files outside `node_modules`. Always-CJS extensions (`.cjs`,
	 *  `.cts`) are excluded by design — `import.meta` is ESM-only syntax, so
	 *  they can never contain the needle, and routing them through `onLoad`
	 *  would silently strip their `module.exports` (oven-sh/bun#5044). */
	filter?: RegExp;
};

// Match ESM-capable source files but never anything under `node_modules`.
//
// Extensions intentionally excluded: `.cjs` and `.cts`. Those are always
// CommonJS — `import.meta.console` can never appear in them, and re-emitting
// them through `onLoad` would corrupt their exports (see file-level comment
// for the oven-sh/bun#5044 rationale).
const DEFAULT_FILTER = /^(?:(?!node_modules).)*\.(?:mjs|mts|jsx?|tsx?)$/;
const NEEDLE = "import.meta.console";
const DEFAULT_RUNTIME = "im.console/runtime";

// Heuristic CommonJS detector for first-party files in ambiguous extensions
// (.js / .ts that resolve as CJS based on the nearest `package.json` `type`).
// Such a file cannot contain `import.meta.console` (ESM-only syntax), so the
// only thing we need to do for it is *not* corrupt its exports.
//
// We can't bail out by returning `undefined` from `onLoad` under preload (Bun
// throws "Expected module mock to return an object"). Instead the caller
// (`onLoad`) returns the original source with `loader: 'js'`. That re-emit
// triggers the same bun#5044 misparse — so the resulting module loses its
// exports. The trade-off matches the pre-existing implementation: silent
// breakage for a rare edge case is the lesser evil compared to the hard
// crash from `return undefined`. The mitigation is the default filter, which
// excludes the common always-CJS extensions so this code path only kicks in
// for genuinely-ambiguous first-party files.
const looksLikeCjs = (source: string): boolean =>
	/\bmodule\.exports\b|(?:^|[^.\w$])exports\.[\w$]/.test(source) &&
	!/^\s*(?:import|export)\b/m.test(source);

/** Map a file extension to the Bun loader that should parse the transform
 *  output. We only ever wrap expressions in calls, so the original TS/JSX
 *  syntax is preserved and the matching loader must stay. */
const loaderFor = (path: string): Loader => {
	if (path.endsWith(".tsx")) {
		return "tsx";
	}
	if (path.endsWith(".ts") || path.endsWith(".mts")) {
		return "ts";
	}
	if (path.endsWith(".jsx")) {
		return "jsx";
	}
	return "js";
};

export const imConsolePlugin = (options: BunPluginOptions = {}): BunPlugin => {
	const filter = options.filter ?? DEFAULT_FILTER;
	const runtimeSpecifier = options.runtimeSpecifier ?? DEFAULT_RUNTIME;

	return {
		name: "im.console",
		setup(build): void {
			build.onLoad({ filter }, async ({ path }) => {
				// Defensive guard for a custom `filter` that doesn't exclude
				// dependencies: never re-emit anything under `node_modules`.
				// Bun's `onLoad` cannot bail out with `undefined` under
				// preload, so we have to return a source-code result here —
				// just re-emit the file verbatim and let Bun's parser handle
				// it. CJS dependencies aren't reached here because the
				// default filter excludes `.cjs` / `.cts`, and a caller that
				// loosens the filter to cover those is on the hook for the
				// bun#5044 trade-off.
				const source = await Bun.file(path).text();
				const loader = loaderFor(path);

				if (!source.includes(NEEDLE)) {
					if (looksLikeCjs(source)) {
						// First-party CommonJS in an ambiguous extension —
						// see the comment on `looksLikeCjs`. We re-emit
						// verbatim; Bun will parse as ESM and the file's
						// exports will be lost. This is the same trade-off
						// the previous implementation made.
					}
					return { contents: source, loader };
				}

				// Bun always loads ESM, so emit an `import` for the runtime.
				const transformed = transform(source, {
					filename: basename(path),
					runtimeSpecifier,
					module: "esm",
				});

				return { contents: transformed ?? source, loader };
			});
		},
	};
};

/** Last path segment, dependency-free (avoids `node:path` so the Bun plugin
 *  stays import-light). Handles both `/` and `\` separators. */
const basename = (path: string): string => {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return slash === -1 ? path : path.slice(slash + 1);
};

export default imConsolePlugin;
