import { transformSync } from "@babel/core";
import { describe, expect, test } from "vite-plus/test";
import plugin from "../src/plugin/index.ts";

const transform = (source: string): string => {
	const result = transformSync(source, {
		filename: "sample.ts",
		configFile: false,
		babelrc: false,
		parserOpts: {
			sourceType: "module",
			plugins: ["typescript"],
		},
		plugins: [[plugin, { runtimeSpecifier: "./runtime.js" }]],
	});
	return result?.code ?? "";
};

describe("babel plugin", () => {
	test("does not rewrite direct import.meta.console calls as log shorthand", () => {
		const code = transform(`
			import.meta.console("direct");
			import.meta.console.log("method");
		`);

		expect(code).toContain('import.meta.console("direct")');
		expect(code).toContain("__imConsole");
		expect(code).toContain('"method"');
	});
});
