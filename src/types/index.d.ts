/* eslint-disable @typescript-eslint/consistent-type-definitions */

/**
 * Ambient type for `import.meta.console`.
 *
 * `import.meta.console` exposes the same surface as the global `Console`
 * (log/warn/error/info/debug/trace/table/dir/group/groupEnd/time/timeEnd/
 * timeLog/count/countReset/assert/clear). The babel plugin rewrites every
 * call so the corresponding `console.*` invocation is prefixed with the
 * source file's basename plus the call site's line:col.
 *
 * It's also directly callable as shorthand for `import.meta.console.log`.
 */
declare global {
	interface ImportMeta {
		readonly console: Console & ((...args: unknown[]) => void);
	}
}

export {};

/* eslint-enable @typescript-eslint/consistent-type-definitions */
