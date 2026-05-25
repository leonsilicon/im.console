/**
 * Babel plugin: rewrites `import.meta.console.<method>(...)` into a runtime
 * call that forwards to `console.<method>` with a `[file:line:col]` prefix
 * baked in at build time.
 *
 * Supported shapes:
 *   import.meta.console.log('hello')
 *   import.meta.console.warn('oops')
 *   import.meta.console('hello')                 // shorthand for .log
 *   import.meta.console?.error('boom')           // optional chain
 *   import.meta.console.log?.('hello')           // optional call
 *
 *   // Value form — captures location where the reference is taken:
 *   const logger = import.meta.console.warn
 *   const c      = import.meta.console
 *
 * Hot-path optimization:
 *
 *   Most files in a typical bundle don't reference `import.meta.console`.
 *   We register a single `Program.enter` visitor and short-circuit on the
 *   raw source — if the substring `import.meta.console` is absent, we
 *   return immediately and Babel never traverses any further on our
 *   behalf. Matching files run a one-shot `programPath.traverse(...)`
 *   that visits CallExpression/OptionalCallExpression nodes scoped to
 *   this plugin alone.
 *
 *   Net effect: non-matching files cost one `String.includes` per file;
 *   matching files run the original transform exactly once.
 */
import { basename } from 'node:path';
import type { NodePath, PluginObj, PluginPass } from '@babel/core';
import type * as BabelTypes from '@babel/types';

export type PluginOptions = {
	/** Module format to emit. Defaults to `'esm'`. */
	module?: 'esm' | 'cjs';

	/** Module specifier for the runtime. Defaults to `'im.console/runtime'`. */
	runtimeSpecifier?: string;

	/** Override the filename baked into each call. By default the plugin uses
	 *  `path.basename(state.filename)`. Useful for testing. */
	filename?: string;
};

const DEFAULT_RUNTIME = 'im.console/runtime';
const RUNTIME_LOCAL_HINT = '_imConsoleRuntime';
const NEEDLE = 'import.meta.console';

const resolveFilename = (state: PluginPass, override: string | undefined): string | undefined => {
	if (override !== undefined && override !== '') {
		return override;
	}
	const { filename } = state;
	if (filename === undefined || filename === '') {
		return;
	}
	return basename(filename);
};

type BabelApi = { types: typeof BabelTypes };

const isImportMetaConsole = (node: BabelTypes.Node): boolean => {
	if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') {
		return false;
	}
	if (node.computed || node.property.type !== 'Identifier' || node.property.name !== 'console') {
		return false;
	}
	const obj = node.object;
	return (
		obj.type === 'MetaProperty'
		&& obj.meta.name === 'import'
		&& obj.property.name === 'meta'
	);
};

/** Returns the console method name being called (`'log'`, `'warn'`, etc.),
 * or `undefined` if the call site doesn't target `import.meta.console`. The
 * callable shorthand `import.meta.console(...)` returns `'log'`. */
const classifyMethod = (callee: BabelTypes.Node): string | undefined => {
	if (isImportMetaConsole(callee)) {
		return 'log';
	}
	if (
		(callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')
		|| callee.computed
		|| callee.property.type !== 'Identifier'
		|| !isImportMetaConsole(callee.object)
	) {
		return;
	}
	return callee.property.name;
};

const plugin = ({ types: t }: BabelApi): PluginObj<PluginPass> => ({
	name: 'transform-import-meta-console',

	visitor: {
		Program(programPath, state): void {
			// Cheap substring check on the raw source — bail out before
			// touching the AST for files that don't reference the needle.
			const source = state.file.code;
			if (typeof source !== 'string' || !source.includes(NEEDLE)) {
				return;
			}

			const options = (state.opts as PluginOptions | undefined) ?? {};
			const filename = resolveFilename(state, options.filename);
			if (filename === undefined) {
				return;
			}

			let runtimeLocal: string | undefined;
			let matched = false;

			const ensureRuntimeLocal = (): string => {
				if (runtimeLocal === undefined) {
					runtimeLocal = programPath.scope.generateUid(RUNTIME_LOCAL_HINT);
				}
				return runtimeLocal;
			};

			const rewriteCall = (
				callPath: NodePath<BabelTypes.CallExpression>
					| NodePath<BabelTypes.OptionalCallExpression>,
			): void => {
				const { node } = callPath;
				const method = classifyMethod(node.callee);
				if (method === undefined) {
					return;
				}
				const { loc } = node;
				if (!loc) {
					return;
				}

				const local = ensureRuntimeLocal();

				callPath.replaceWith(
					t.callExpression(
						t.memberExpression(
							t.identifier(local),
							t.identifier('__imConsole'),
						),
						[
							t.stringLiteral(filename),
							t.numericLiteral(loc.start.line),
							t.numericLiteral(loc.start.column + 1),
							t.stringLiteral(method),
							...node.arguments,
						],
					),
				);
				matched = true;
			};

			const rewriteValue = (
				memberPath: NodePath<BabelTypes.MemberExpression>
					| NodePath<BabelTypes.OptionalMemberExpression>,
			): void => {
				const { node } = memberPath;
				// `import.meta.console.<method>` as a value — emit __imConsoleBind.
				if (
					!node.computed
					&& node.property.type === 'Identifier'
					&& isImportMetaConsole(node.object)
				) {
					const { loc } = node;
					if (!loc) {
						return;
					}
					const local = ensureRuntimeLocal();
					memberPath.replaceWith(
						t.callExpression(
							t.memberExpression(
								t.identifier(local),
								t.identifier('__imConsoleBind'),
							),
							[
								t.stringLiteral(filename),
								t.numericLiteral(loc.start.line),
								t.numericLiteral(loc.start.column + 1),
								t.stringLiteral(node.property.name),
							],
						),
					);
					matched = true;
					return;
				}
				// Bare `import.meta.console` as a value — emit __imConsoleBindObject.
				if (isImportMetaConsole(node)) {
					const { loc } = node;
					if (!loc) {
						return;
					}
					const local = ensureRuntimeLocal();
					memberPath.replaceWith(
						t.callExpression(
							t.memberExpression(
								t.identifier(local),
								t.identifier('__imConsoleBindObject'),
							),
							[
								t.stringLiteral(filename),
								t.numericLiteral(loc.start.line),
								t.numericLiteral(loc.start.column + 1),
							],
						),
					);
					matched = true;
				}
			};

			// First pass: rewrite calls. Replacing the whole call also
			// consumes the inner `import.meta.console[.method]` node, so
			// the value-form pass below only sees genuine value references.
			programPath.traverse({
				CallExpression(callPath): void {
					rewriteCall(callPath);
				},
				OptionalCallExpression(callPath): void {
					rewriteCall(callPath);
				},
			});

			// Second pass: any surviving `import.meta.console[.method]`
			// member expressions are value references — bind them.
			programPath.traverse({
				MemberExpression(memberPath): void {
					rewriteValue(memberPath);
				},
				OptionalMemberExpression(memberPath): void {
					rewriteValue(memberPath);
				},
			});

			if (!matched || runtimeLocal === undefined) {
				return;
			}

			const moduleType = options.module ?? 'esm';
			const specifier = options.runtimeSpecifier ?? DEFAULT_RUNTIME;
			const localId = t.identifier(runtimeLocal);
			const specifierLiteral = t.stringLiteral(specifier);
			const declaration = moduleType === 'cjs'
				? t.variableDeclaration('var', [
					t.variableDeclarator(
						localId,
						t.callExpression(t.identifier('require'), [specifierLiteral]),
					),
				])
				: t.importDeclaration(
					[t.importNamespaceSpecifier(localId)],
					specifierLiteral,
				);
			programPath.unshiftContainer('body', declaration);
		},
	},
});

export default plugin;
