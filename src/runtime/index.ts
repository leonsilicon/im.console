/**
 * Runtime for `import.meta.console.*`.
 *
 * The babel plugin rewrites every call like
 *
 *   import.meta.console.log('hello', user)
 *
 * into
 *
 *   __imConsoleRuntime.__imConsole('file.tsx', 12, 7, 'log', 'hello', user)
 *
 * and this runtime forwards the arguments to `console.log` with a
 * `[file.tsx:12:7]` prefix prepended.
 *
 * Method routing:
 *   - log, warn, error, info, debug, trace, group, groupCollapsed
 *       → prefix the first argument with `[file:line:col]`
 *   - assert
 *       → keep condition as the first argument, prefix the message
 *   - dir, table, time, timeEnd, timeLog, count, countReset, groupEnd, clear
 *       → forward arguments verbatim (the location prefix would corrupt
 *         label-based methods like time/timeEnd or skew dir/table output)
 *
 * `console` is available in every JS runtime (Node, Hermes, browsers,
 * Workers), so the runtime has no environment dependencies. If a method
 * isn't present on the host's `console`, the runtime silently falls back
 * to `console.log`.
 */

type AnyConsole = Record<string, ((...args: unknown[]) => void) | undefined>;

const PASS_THROUGH = new Set<string>([
	'clear',
	'groupEnd',
	'time',
	'timeEnd',
	'timeLog',
	'count',
	'countReset',
	'dir',
	'dirxml',
	'table',
	'profile',
	'profileEnd',
	'timeStamp',
]);

const callConsole = (method: string, args: readonly unknown[]): void => {
	const host = console as unknown as AnyConsole;
	const fn = host[method] ?? host.log;
	if (fn === undefined) {
		return;
	}
	fn.apply(console, args as unknown[]);
};

const prefixed = (method: string, args: readonly unknown[], location: string): void => {
	const host = console as unknown as AnyConsole;
	const fn = host[method] ?? host.log;
	if (fn === undefined) {
		return;
	}
	if (args.length === 0) {
		fn.call(console, location);
		return;
	}
	const [first, ...rest] = args;
	if (typeof first === 'string') {
		fn.call(console, `${location} ${first}`, ...rest);
	} else {
		fn.call(console, location, first, ...rest);
	}
};

const assertWithLocation = (args: readonly unknown[], location: string): void => {
	const host = console as unknown as AnyConsole;
	const fn = host.assert ?? host.log;
	if (fn === undefined) {
		return;
	}
	if (args.length === 0) {
		fn.call(console, false, location);
		return;
	}
	const [condition, ...rest] = args;
	if (rest.length === 0) {
		fn.call(console, condition, location);
		return;
	}
	const [first, ...tail] = rest;
	if (typeof first === 'string') {
		fn.call(console, condition, `${location} ${first}`, ...tail);
	} else {
		fn.call(console, condition, location, first, ...tail);
	}
};

/**
 * Emitted by the babel plugin at every `import.meta.console.<method>(...)`
 * call site. `filename` is just the file's basename (the plugin strips the
 * directory) so the log line stays short.
 */
export const __imConsole = (
	filename: string,
	line: number,
	column: number,
	method: string,
	...args: unknown[]
): void => {
	if (PASS_THROUGH.has(method)) {
		callConsole(method, args);
		return;
	}
	const location = `[${filename}:${line}:${column}]`;
	if (method === 'assert') {
		assertWithLocation(args, location);
		return;
	}
	prefixed(method, args, location);
};
