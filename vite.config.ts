import { defineConfig } from "vite-plus";

export default defineConfig({
	fmt: {},
	lint: {
		jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
		rules: { "vite-plus/prefer-vite-plus-imports": "error" },
		options: { typeAware: true, typeCheck: true },
	},
	// `vp pack` is tsdown under the hood. Vite+ ships tsdown internally, so the
	// config lives here as plain data rather than importing `tsdown`.
	pack: [
		{
			entry: { "runtime/index": "src/runtime/index.ts" },
			format: ["esm", "cjs"],
			platform: "neutral",
			dts: true,
			clean: true,
		},
		{
			entry: { "plugin/index": "src/plugin/index.ts" },
			format: ["esm", "cjs"],
			platform: "node",
			dts: true,
		},
		{
			entry: {
				"bun/index": "src/bun/index.ts",
				"bun/preload": "src/bun/preload.ts",
			},
			// Bun is ESM-only; no CJS output needed.
			format: ["esm"],
			platform: "node",
			dts: true,
		},
	],
	test: {
		// The bun-plugin tests spawn `bun` as a subprocess and touch the
		// filesystem, so they run in Node (not jsdom) and need a generous
		// timeout for cold installs/builds.
		environment: "node",
		include: ["test/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
