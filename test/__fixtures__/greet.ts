// Imported module that uses `import.meta.console`. The transform must reach
// this file even though it is not the entry that `bun` is invoked on.
export const greet = (name: string): void => {
	import.meta.console.log("hello", name);
	import.meta.console.warn("be careful");
	import.meta.console.info("secondary log");
};
