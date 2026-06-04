import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

const preload = fileURLToPath(new URL("__fixtures__/preload.ts", import.meta.url));
const entry = fileURLToPath(new URL("__fixtures__/entry.ts", import.meta.url));

type Run = { stdout: string; stderr: string; exitCode: number };

/** Run `bun` as a subprocess and collect its output. The plugin transform
 *  happens inside that child Bun process; Vitest just drives and inspects it. */
const spawnBun = (args: string[], cwd?: string): Promise<Run> =>
	new Promise((resolve, reject) => {
		const child = spawn("bun", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});

const runEntry = (): Promise<Run> => spawnBun(["--preload", preload, entry]);

describe("bun plugin", () => {
	test("transforms import.meta.console in an imported file (not just the entry)", async () => {
		const { stdout, stderr, exitCode } = await runEntry();

		expect(exitCode).toBe(0);

		// `console.log` goes to stdout; `console.warn`/`console.error` to
		// stderr. The imported module's calls must be transformed — this is
		// the core claim being tested.
		expect(stdout).toContain("[greet.ts:4:2] hello world");
		expect(stdout).toContain("[greet.ts:6:2] shorthand log");
		expect(stderr).toContain("[greet.ts:5:2] be careful");

		// The entry file itself is transformed too.
		expect(stderr).toContain("[entry.ts:9:1] from entry");
	});

	test("leaves the raw needle absent from the program output", async () => {
		const { stdout } = await runEntry();
		// If the transform had failed silently and `import.meta.console` were
		// evaluated at runtime, it would throw rather than print a prefix.
		expect(stdout).not.toContain("import.meta.console");
	});

	test("works via bunfig.toml preload with a plain `bun entry.ts` (no --preload flag)", async () => {
		const cwd = fileURLToPath(new URL("__fixtures__/bunfig/", import.meta.url));
		// No --preload flag here: the plugin is wired through this directory's
		// bunfig.toml `preload`, picked up because cwd points at it.
		const { stdout, exitCode } = await spawnBun(["entry.ts"], cwd);

		expect(exitCode).toBe(0);
		// Imported file transformed without any CLI flag.
		expect(stdout).toContain("[dep.ts:2:2] ping from dep");
		// Entry transformed too.
		expect(stdout).toContain("[entry.ts:4:1] entry main");
	});

	test("resolves the published `im.console/bun/preload` specifier via a workspace dependency", async () => {
		// The `test-package` fixture depends on `im.console` through a pnpm
		// `workspace:*` link to the package at the repo root and wires the
		// plugin with the *exact* README string —
		// `preload = ["im.console/bun/preload"]` — rather than a source path.
		// Running plain `bun entry.ts` there proves that documented form works.
		const cwd = fileURLToPath(new URL("__fixtures__/test-package/", import.meta.url));
		const { stdout, exitCode } = await spawnBun(["entry.ts"], cwd);

		expect(exitCode).toBe(0);
		expect(stdout).toContain("[dep.ts:2:2] ping from dep");
		expect(stdout).toContain("[entry.ts:4:1] entry main");
	});
});
