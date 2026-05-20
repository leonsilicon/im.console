/**
 * React Native runtime for `import.meta.debug?.(...)`.
 *
 * Designed for Hermes — no dependency on the `debug` package, no `tty`,
 * `process.stderr`, or `localStorage`. Logs to `console.log` so messages
 * surface in the Metro server output and any in-app log overlays.
 *
 * Behavior:
 *   - Each call site is rewritten by the babel plugin to pass the source
 *     URL/path plus the line and column. The runtime prefixes the log with
 *     `[<short path>:<line>:<col>]`.
 *   - In `__DEV__`, logs are emitted unconditionally unless a namespace
 *     filter is active and excludes the call site.
 *   - Outside `__DEV__`, logs are suppressed unless a namespace filter
 *     explicitly enables them.
 *   - Namespace filters can be configured via either:
 *       globalThis.__IM_DEBUG__ = '*,-noise:*'
 *       process.env.DEBUG       = 'auth:*'
 *     using the same comma-separated wildcard syntax as the `debug` package.
 */

type Filter = {
	enabled: (namespace: string) => boolean;
};

const FILE_PROTOCOL = 'file://';

const fileUrlToPath = (url: string): string => {
	let pathname = url.slice(FILE_PROTOCOL.length);
	const slash = pathname.indexOf('/');
	if (slash > 0) {
		pathname = pathname.slice(slash);
	}
	return pathname.replace(/%([\da-f]{2})/gi, (_match, hex: string) => (
		String.fromCharCode(Number.parseInt(hex, 16))
	));
};

const basename = (path: string): string => {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? path : path.slice(idx + 1);
};

/** Used for matching against namespace filters — full file path so users
 * can target a directory with `pages/*` patterns. */
const namespaceFor = (url: string): string => {
	if (url.startsWith(FILE_PROTOCOL)) {
		return fileUrlToPath(url);
	}
	return url;
};

/** Used in the rendered `[name:line:col]` prefix — just the basename so the
 * log line stays short and readable in the Metro console. */
const labelFor = (url: string): string => basename(namespaceFor(url));

const escapeForRegex = (pattern: string): string => (
	pattern.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')
);

const patternToRegex = (pattern: string): RegExp => {
	const body = pattern.split('*').map(escapeForRegex).join('.*?');
	return new RegExp(`^${body}$`);
};

const parseFilter = (raw: string | undefined): Filter | undefined => {
	if (raw === undefined || raw === '') {
		return;
	}
	const enabled: RegExp[] = [];
	const disabled: RegExp[] = [];
	for (const part of raw.split(/[\s,]+/)) {
		if (part === '') continue;
		if (part.startsWith('-')) {
			disabled.push(patternToRegex(part.slice(1)));
		} else {
			enabled.push(patternToRegex(part));
		}
	}
	return {
		enabled: (namespace: string) => {
			for (const re of disabled) {
				if (re.test(namespace)) {
					return false;
				}
			}
			for (const re of enabled) {
				if (re.test(namespace)) {
					return true;
				}
			}
			return enabled.length === 0;
		},
	};
};

type Globals = {
	__IM_DEBUG__?: string;
	__DEV__?: boolean;
	process?: { env?: { DEBUG?: string } };
};

const readFilterSource = (): string | undefined => {
	const g = globalThis as unknown as Globals;
	if (typeof g.__IM_DEBUG__ === 'string') {
		return g.__IM_DEBUG__;
	}
	return g.process?.env?.DEBUG;
};

let cachedFilter: Filter | undefined;
let cachedFilterSource: string | undefined;
let filterInitialized = false;

const getFilter = (): Filter | undefined => {
	const source = readFilterSource();
	if (!filterInitialized || source !== cachedFilterSource) {
		cachedFilter = parseFilter(source);
		cachedFilterSource = source;
		filterInitialized = true;
	}
	return cachedFilter;
};

const isDev = (): boolean => {
	const g = globalThis as unknown as Globals;
	return g.__DEV__ === true;
};

const isEnabledFor = (namespace: string): boolean => {
	const filter = getFilter();
	if (filter !== undefined) {
		return filter.enabled(namespace);
	}
	return isDev();
};

/**
 * Emitted by the babel plugin in place of every `import.meta.debug?.(...)`
 * call. Receives the source URL and call-site coordinates that the plugin
 * computed at build time so the runtime never has to walk a stack.
 */
export const __imDotDebug = (
	url: string,
	line: number,
	column: number,
	...args: unknown[]
): void => {
	const namespace = namespaceFor(url);
	if (!isEnabledFor(namespace)) {
		return;
	}

	const location = `[${labelFor(url)}:${line}:${column}]`;
	if (args.length === 0) {
		console.log(location);
		return;
	}

	const [first, ...rest] = args;
	if (typeof first === 'string') {
		console.log(`${location} ${first}`, ...rest);
	} else {
		console.log(location, first, ...rest);
	}
};
