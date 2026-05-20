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
 * The `filename` baked into each call is the source file's basename, not
 * the absolute path, so the runtime log line stays short.
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

const isImportMeta = (node: BabelTypes.Node): boolean => (
	node.type === 'MetaProperty'
	&& node.meta.name === 'import'
	&& node.property.name === 'meta'
);

/** Matches `import.meta.console` and `import.meta?.console`. */
const isImportMetaConsole = (node: BabelTypes.Node): boolean => (
	(node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression')
	&& !node.computed
	&& node.property.type === 'Identifier'
	&& node.property.name === 'console'
	&& isImportMeta(node.object)
);

type CalleeShape =
	| { kind: 'method'; method: string }
	| { kind: 'callable' };

/** Inspect a CallExpression's callee and decide whether it targets
 * `import.meta.console.<method>` or `import.meta.console` directly. */
const classifyCallee = (callee: BabelTypes.Node): CalleeShape | undefined => {
	if (isImportMetaConsole(callee)) {
		return { kind: 'callable' };
	}
	if (
		(callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
		&& !callee.computed
		&& callee.property.type === 'Identifier'
		&& isImportMetaConsole(callee.object)
	) {
		return { kind: 'method', method: callee.property.name };
	}
	return;
};

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

type State = PluginPass & {
	imcFilename?: string;
	imcRuntimeLocal?: string;
	imcMatched?: boolean;
};

type BabelApi = { types: typeof BabelTypes };

const plugin = ({ types: t }: BabelApi): PluginObj<State> => ({
	name: 'transform-import-meta-console',

	visitor: {
		Program: {
			enter(programPath, state): void {
				const options = (state.opts as PluginOptions | undefined) ?? {};
				const filename = resolveFilename(state, options.filename);
				if (filename === undefined) {
					return;
				}
				state.imcFilename = filename;
				state.imcRuntimeLocal = programPath.scope.generateUid(RUNTIME_LOCAL_HINT);
				state.imcMatched = false;
			},
			exit(programPath, state): void {
				if (state.imcMatched !== true || state.imcRuntimeLocal === undefined) {
					return;
				}
				const options = (state.opts as PluginOptions | undefined) ?? {};
				const moduleType = options.module ?? 'esm';
				const specifier = options.runtimeSpecifier ?? DEFAULT_RUNTIME;
				const local = t.identifier(state.imcRuntimeLocal);
				const specifierLiteral = t.stringLiteral(specifier);
				const declaration = moduleType === 'cjs'
					? t.variableDeclaration('var', [
						t.variableDeclarator(
							local,
							t.callExpression(t.identifier('require'), [specifierLiteral]),
						),
					])
					: t.importDeclaration(
						[t.importNamespaceSpecifier(local)],
						specifierLiteral,
					);
				programPath.unshiftContainer('body', declaration);
			},
		},

		CallExpression(callPath, state): void {
			rewrite(t, callPath, state);
		},

		OptionalCallExpression(callPath, state): void {
			rewrite(t, callPath, state);
		},
	},
});

const rewrite = (
	t: typeof BabelTypes,
	callPath: NodePath<BabelTypes.CallExpression> | NodePath<BabelTypes.OptionalCallExpression>,
	state: State,
): void => {
	const { node } = callPath;
	const shape = classifyCallee(node.callee);
	if (shape === undefined) {
		return;
	}
	const filename = state.imcFilename;
	const local = state.imcRuntimeLocal;
	if (filename === undefined || local === undefined) {
		return;
	}
	const { loc } = node;
	if (!loc) {
		return;
	}

	const method = shape.kind === 'method' ? shape.method : 'log';

	const newCall = t.callExpression(
		t.memberExpression(t.identifier(local), t.identifier('__imConsole')),
		[
			t.stringLiteral(filename),
			t.numericLiteral(loc.start.line),
			t.numericLiteral(loc.start.column + 1),
			t.stringLiteral(method),
			...node.arguments,
		],
	);

	callPath.replaceWith(newCall);
	state.imcMatched = true;
};

export default plugin;
