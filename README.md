# im.console

`import.meta.console.*` — every `console` call gets the source file's
basename plus the call-site line:col baked in at build time.

```ts
import.meta.console.log("hello", user);
import.meta.console.warn("cache miss for", key);
import.meta.console.error("boom", error);
```

becomes

```
[auth.ts:12:3] hello { id: 1 }
[cache.ts:48:5] cache miss for users/42
[handler.ts:7:5] boom Error: boom at ...
```

`import.meta.console` mirrors the full `Console` interface
(`log`/`warn`/`error`/`info`/`debug`/`trace`/`table`/`dir`/`group`/`groupEnd`/
`time`/`timeEnd`/`timeLog`/`count`/`countReset`/`assert`/`clear`). It is also
directly callable as a shorthand for `.log`:

```ts
import.meta.console("quick log"); // → console.log('[file.ts:1:1] quick log')
```

You can also capture a reference and call it later. The location prefix is
baked in where the reference is taken, not where it's called:

```ts
const logger = import.meta.console.warn; // location captured here
const c = import.meta.console; // ditto — `c.error(...)` uses this line
arr.forEach(import.meta.console.log);
```

`import.meta.console.*` is non-optional by design — the babel plugin must be
active for any file that uses it. Code without the plugin running will throw
`TypeError: Cannot read property 'log' of undefined`.

## Install

```sh
npm install --save-dev im.console
```

## Use

Add the Babel plugin:

```js
// babel.config.js
module.exports = {
	presets: ["babel-preset-expo"],
	plugins: ["im.console/plugin"],
};
```

That's it. The plugin rewrites every `import.meta.console.<method>(...)`
into a call to the small `im.console/runtime` module, which forwards to
`console.<method>` with the location prefix prepended.

### Options

```js
[
	"im.console/plugin",
	{
		// 'esm' (default) or 'cjs' — controls how the runtime is imported.
		module: "esm",
		// Override the runtime specifier (rarely needed).
		runtimeSpecifier: "im.console/runtime",
	},
];
```

### Bun

If you run your code directly with Bun (`bun file.ts`), you don't need a
separate Babel build step — `im.console/bun` is a Bun plugin that applies the
same transform on the fly, as each module is loaded.

The recommended wiring is `bunfig.toml`, which makes a plain `bun file.ts`
(no `--preload` flag) Just Work, including for every file `file.ts` imports:

```toml
# bunfig.toml
preload = ["im.console/bun/preload"]
```

`im.console/bun/preload` registers the plugin with default options. For custom
options, write your own preload module instead:

```ts
// im-console-preload.ts
import { imConsolePlugin } from "im.console/bun";

Bun.plugin(
	imConsolePlugin({
		// Override the runtime specifier (rarely needed).
		runtimeSpecifier: "im.console/runtime",
		// Restrict which files are transformed. The default matches all JS/TS
		// source files outside `node_modules`; keep the `node_modules` exclusion
		// in any custom filter, since re-emitting a CommonJS dependency through
		// the plugin breaks its exports (oven-sh/bun#5044).
		filter: /^(?:(?!node_modules).)*\.[cm]?[jt]sx?$/,
	}),
);
```

```toml
# bunfig.toml
preload = ["./im-console-preload.ts"]
```

You can also pass it on the command line instead of via `bunfig.toml`:

```sh
bun --preload ./im-console-preload.ts file.ts
```

Either way the transform reaches the whole module graph — the entry file _and_
every file it imports — because Bun runs preload plugins' `onLoad` hooks for
every module it loads.

### TypeScript

`im.console` ships ambient typings that augment `ImportMeta` with the
`console` property:

```ts
/// <reference types="im.console/types" />
```

Reference it once anywhere in your project (e.g. in a `globals.d.ts` or your
entry file). `import.meta.console.log(...)` will then type-check everywhere.

## Why a build-time transform?

Reading the call-site line/column at runtime requires throwing an `Error`
and parsing its stack on every call. Baking it in at load time keeps the
rewritten code small and the runtime hot path trivial.

## License

MIT.
