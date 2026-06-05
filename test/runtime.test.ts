import { describe, expect, test } from "vite-plus/test";
import { __imConsoleBindObject } from "../src/runtime/index.ts";

describe("runtime", () => {
	test("binds import.meta.console as a non-callable console object", () => {
		const originalLog = console.log;
		const calls: unknown[][] = [];
		console.log = (...args: unknown[]): void => {
			calls.push(args);
		};

		try {
			const bound = __imConsoleBindObject("file.ts", 1, 2);

			expect(typeof bound).toBe("object");
			expect(() => {
				(bound as unknown as (...args: unknown[]) => void)("direct");
			}).toThrow(TypeError);

			bound.log("method");
		} finally {
			console.log = originalLog;
		}

		expect(calls).toEqual([["[file.ts:1:2] method"]]);
	});
});
