/**
 * Zero-dependency `import.meta.console` transform for the Bun loader path.
 *
 * Replaces the previous `@babel/core` transform so the package pulls in no
 * runtime/peer dependencies. Bun exposes no AST API (`Bun.Transpiler` only
 * strips types, and stripping shifts line numbers — which would corrupt the
 * `[file:line:col]` prefix that is the whole point of this package), so we
 * scan the ORIGINAL source by hand and splice in runtime calls by character
 * offset, computing line/column from the original offsets.
 *
 * Supported shapes (identical to the babel plugin in `../plugin`):
 *   import.meta.console.log('hello')             → call
 *   import.meta.console?.error('boom')           → call (optional chain)
 *   import.meta.console.log?.('hello')           → call (optional call)
 *   const logger = import.meta.console.warn       → value (method)
 *   const c      = import.meta.console            → value (object)
 *
 * The scanner skips strings (', ", `…`), comments (// and / * … * /) and regex
 * literals, so a literal `"import.meta.console"` inside a string is never
 * rewritten. After type-stripping by Bun's loader the emitted code is valid
 * because we only ever wrap an existing expression in a call — we never need to
 * understand TS/JSX syntax, just balance brackets to find the end of a call's
 * argument list.
 */

const NEEDLE = "import.meta.console";

export type TransformOptions = {
	/** Basename baked into each rewritten call (e.g. `"greet.ts"`). */
	filename: string;

	/** Module specifier the runtime is imported from. */
	runtimeSpecifier: string;

	/** Local identifier the runtime namespace is bound to. Must not collide
	 *  with anything in the source; the default is deliberately obscure. */
	runtimeLocal?: string;

	/** `"esm"` emits `import * as <local> from <spec>`; `"cjs"` emits
	 *  `var <local> = require(<spec>)`. Bun always loads ESM, so the Bun
	 *  plugin passes `"esm"`. */
	module?: "esm" | "cjs";
};

const DEFAULT_RUNTIME_LOCAL = "_imConsoleRuntime";

/** A whitespace / line-terminator character per the lexer's needs. */
const isWs = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";

/** ASCII identifier-continue test (sufficient: we only read JS keywords and
 *  member names, which are ASCII in this grammar). `$` and `_` included. */
const isIdentPart = (ch: string): boolean =>
	(ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "$" || ch === "_";

/**
 * Whether a `/` at `index` begins a regex literal rather than a division
 * operator. Heuristic identical to what hand-written JS lexers use: look at the
 * previous non-whitespace, non-comment token — a regex can only follow a
 * position where a value is NOT expected to its left (operators, `(`, `,`, `=`,
 * `return`, etc.). Good enough for source we only need to *skip* over.
 */
const regexAllowedBefore = (src: string, index: number): boolean => {
	let i = index - 1;
	while (i >= 0 && isWs(src[i] as string)) {
		i--;
	}
	if (i < 0) {
		return true;
	}
	const ch = src[i] as string;
	// After these, a `/` is division (a value precedes it).
	if (isIdentPart(ch) || ch === ")" || ch === "]" || ch === "}") {
		// `}` and identifiers can precede a regex in some keyword cases
		// (`return`, `typeof`, etc.). Check for a keyword ending here.
		if (isIdentPart(ch)) {
			let j = i;
			while (j >= 0 && isIdentPart(src[j] as string)) {
				j--;
			}
			const word = src.slice(j + 1, i + 1);
			const KEYWORDS = new Set([
				"return",
				"typeof",
				"instanceof",
				"in",
				"of",
				"new",
				"delete",
				"void",
				"do",
				"else",
				"yield",
				"await",
				"case",
			]);
			return KEYWORDS.has(word);
		}
		return false;
	}
	return true;
};

type Found = { index: number; line: number; column: number };

/**
 * Find every real `import.meta.console` occurrence (skipping strings, comments
 * and regex literals), returning its start offset plus 1-based line and 0-based
 * column. Single forward pass; tracks line/column as it goes.
 */
const findOccurrences = (src: string): Found[] => {
	const out: Found[] = [];
	let line = 1;
	let column = 0;
	const len = src.length;

	const advance = (n: number): void => {
		for (let k = 0; k < n; k++) {
			if (src[/* current */ i + k] === "\n") {
				line++;
				column = 0;
			} else {
				column++;
			}
		}
	};

	let i = 0;
	while (i < len) {
		const ch = src[i] as string;

		// Line comment.
		if (ch === "/" && src[i + 1] === "/") {
			while (i < len && src[i] !== "\n") {
				advance(1);
				i++;
			}
			continue;
		}
		// Block comment.
		if (ch === "/" && src[i + 1] === "*") {
			advance(2);
			i += 2;
			while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
				advance(1);
				i++;
			}
			advance(2);
			i += 2;
			continue;
		}
		// String literals.
		if (ch === '"' || ch === "'") {
			const quote = ch;
			advance(1);
			i++;
			while (i < len && src[i] !== quote) {
				if (src[i] === "\\") {
					advance(2);
					i += 2;
					continue;
				}
				advance(1);
				i++;
			}
			advance(1);
			i++;
			continue;
		}
		// Template literal (no interpolation tracking needed — we only skip;
		// a `${ … }` may itself contain the needle, so DO scan inside it).
		if (ch === "`") {
			advance(1);
			i++;
			while (i < len && src[i] !== "`") {
				if (src[i] === "\\") {
					advance(2);
					i += 2;
					continue;
				}
				// Enter `${ … }` — scan its contents normally by just not
				// skipping; break out of the template-skip loop.
				if (src[i] === "$" && src[i + 1] === "{") {
					// Walk the interpolation with bracket balancing, but still
					// detect the needle inside it.
					advance(2);
					i += 2;
					let depth = 1;
					while (i < len && depth > 0) {
						if (src.startsWith(NEEDLE, i) && !isIdentPart(src[i - 1] ?? " ") && !isIdentPart(src[i + NEEDLE.length] ?? " ")) {
							out.push({ index: i, line, column });
							advance(NEEDLE.length);
							i += NEEDLE.length;
							continue;
						}
						if (src[i] === "{") {
							depth++;
						} else if (src[i] === "}") {
							depth--;
						}
						advance(1);
						i++;
					}
					continue;
				}
				advance(1);
				i++;
			}
			advance(1);
			i++;
			continue;
		}
		// Regex literal.
		if (ch === "/" && regexAllowedBefore(src, i)) {
			advance(1);
			i++;
			let inClass = false;
			while (i < len) {
				const c = src[i] as string;
				if (c === "\\") {
					advance(2);
					i += 2;
					continue;
				}
				if (c === "[") {
					inClass = true;
				} else if (c === "]") {
					inClass = false;
				} else if (c === "/" && !inClass) {
					break;
				} else if (c === "\n") {
					break; // not a regex after all; bail
				}
				advance(1);
				i++;
			}
			advance(1);
			i++;
			continue;
		}
		// The needle — must be a standalone token (not part of a longer ident).
		if (
			src.startsWith(NEEDLE, i) &&
			!isIdentPart(src[i - 1] ?? " ") &&
			!isIdentPart(src[i + NEEDLE.length] ?? " ")
		) {
			out.push({ index: i, line, column });
			advance(NEEDLE.length);
			i += NEEDLE.length;
			continue;
		}

		advance(1);
		i++;
	}

	return out;
};

/** Skip whitespace and comments forward from `i`; returns the next code index. */
const skipTrivia = (src: string, i: number): number => {
	const len = src.length;
	while (i < len) {
		const ch = src[i] as string;
		if (isWs(ch)) {
			i++;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < len && src[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
				i++;
			}
			i += 2;
			continue;
		}
		break;
	}
	return i;
};

/** Read an identifier starting at `i` (already known to be ident-start).
 *  Returns the name and the index just past it. */
const readIdent = (src: string, i: number): { name: string; end: number } => {
	const start = i;
	while (i < src.length && isIdentPart(src[i] as string)) {
		i++;
	}
	return { name: src.slice(start, i), end: i };
};

/** Find the matching close paren for an open paren at `open`. Skips nested
 *  brackets, strings, templates and comments. Returns the index of `)`. */
const matchParen = (src: string, open: number): number => {
	const len = src.length;
	let depth = 0;
	let i = open;
	while (i < len) {
		const ch = src[i] as string;
		if (ch === '"' || ch === "'") {
			const q = ch;
			i++;
			while (i < len && src[i] !== q) {
				if (src[i] === "\\") {
					i += 2;
					continue;
				}
				i++;
			}
			i++;
			continue;
		}
		if (ch === "`") {
			i++;
			let tdepth = 0;
			while (i < len) {
				if (src[i] === "\\") {
					i += 2;
					continue;
				}
				if (src[i] === "`" && tdepth === 0) {
					break;
				}
				if (src[i] === "$" && src[i + 1] === "{") {
					tdepth++;
					i += 2;
					continue;
				}
				if (src[i] === "}" && tdepth > 0) {
					tdepth--;
				}
				i++;
			}
			i++;
			continue;
		}
		if (ch === "/" && src[i + 1] === "/") {
			while (i < len && src[i] !== "\n") {
				i++;
			}
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			i += 2;
			while (i < len && !(src[i] === "*" && src[i + 1] === "/")) {
				i++;
			}
			i += 2;
			continue;
		}
		if (ch === "(" || ch === "[" || ch === "{") {
			depth++;
		} else if (ch === ")" || ch === "]" || ch === "}") {
			depth--;
			if (depth === 0 && ch === ")") {
				return i;
			}
		}
		i++;
	}
	return -1;
};

type Edit = { start: number; end: number; text: string };

/**
 * Transform `source`, returning the rewritten code, or `undefined` when nothing
 * matched (caller re-emits the original verbatim).
 */
export const transform = (source: string, options: TransformOptions): string | undefined => {
	if (!source.includes(NEEDLE)) {
		return undefined;
	}

	const runtimeLocal = options.runtimeLocal ?? DEFAULT_RUNTIME_LOCAL;
	const fileLit = JSON.stringify(options.filename);
	const occurrences = findOccurrences(source);
	if (occurrences.length === 0) {
		return undefined;
	}

	const edits: Edit[] = [];
	let matched = false;

	for (const occ of occurrences) {
		const line = occ.line;
		const col = occ.column + 1; // runtime expects 1-based column
		const loc = `${fileLit}, ${line}, ${col}`;
		// Cursor at the char just after `import.meta.console`.
		const afterNeedle = occ.index + NEEDLE.length;

		// Look at what follows: `.method`, `?.method`, `?.(`, `(`, or a value use.
		let j = skipTrivia(source, afterNeedle);
		let optionalConsole = false;
		if (source[j] === "?" && source[j + 1] === ".") {
			optionalConsole = true;
			j = skipTrivia(source, j + 2);
		} else if (source[j] === ".") {
			j = skipTrivia(source, j + 1);
		} else if (source[j] === "(") {
			// `import.meta.console(...)` — direct call. The babel plugin does
			// NOT rewrite this (only `import.meta.console.<method>(...)`), so
			// leave it untouched.
			continue;
		} else {
			// Bare `import.meta.console` used as a value → bind object.
			edits.push({
				start: occ.index,
				end: afterNeedle,
				text: `${runtimeLocal}.__imConsoleBindObject(${loc})`,
			});
			matched = true;
			continue;
		}

		// `j` should now sit on a method identifier.
		if (j >= source.length || !isIdentPart(source[j] as string) || (source[j] >= "0" && source[j] <= "9")) {
			// `import.meta.console.` followed by something non-identifier (very
			// unusual) — leave as-is.
			continue;
		}
		const { name: method, end: methodEnd } = readIdent(source, j);

		// After the method: optional `?.` then maybe `(` for a call.
		let k = skipTrivia(source, methodEnd);
		let optionalCall = false;
		if (source[k] === "?" && source[k + 1] === ".") {
			optionalCall = true;
			k = skipTrivia(source, k + 2);
		}

		if (source[k] === "(") {
			// Call form. Capture the argument list (between the parens).
			const close = matchParen(source, k);
			if (close === -1) {
				continue;
			}
			const argsInner = source.slice(k + 1, close).trim();
			const methodLit = JSON.stringify(method);
			const argList = argsInner.length === 0 ? "" : `, ${argsInner}`;
			edits.push({
				start: occ.index,
				end: close + 1,
				text: `${runtimeLocal}.__imConsole(${loc}, ${methodLit}${argList})`,
			});
			matched = true;
			continue;
		}

		// Value form: `import.meta.console.<method>` not called → bind method.
		// (Optional chaining on either side is irrelevant for a value read.)
		void optionalConsole;
		void optionalCall;
		const methodLit = JSON.stringify(method);
		edits.push({
			start: occ.index,
			end: methodEnd,
			text: `${runtimeLocal}.__imConsoleBind(${loc}, ${methodLit})`,
		});
		matched = true;
	}

	if (!matched) {
		return undefined;
	}

	// Apply edits right-to-left so earlier offsets stay valid.
	edits.sort((a, b) => b.start - a.start);
	let out = source;
	for (const edit of edits) {
		out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
	}

	// Prepend the runtime import/require.
	const specLit = JSON.stringify(options.runtimeSpecifier);
	const header =
		(options.module ?? "esm") === "cjs"
			? `var ${runtimeLocal} = require(${specLit});\n`
			: `import * as ${runtimeLocal} from ${specLit};\n`;

	return header + out;
};

export default transform;
