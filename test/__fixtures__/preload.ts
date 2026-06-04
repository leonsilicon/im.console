// Preload script registered via `bun --preload`. Registering the plugin here
// means it is active for the entire module graph that `bun entry.ts` loads,
// including imported files.
//
// The runtime specifier is pointed at the source runtime (rather than the
// published `im.console/runtime`) so the test does not depend on a prior build.
import { imConsolePlugin } from "../../src/bun/index.ts";

const runtimeSpecifier = new URL("../../src/runtime/index.ts", import.meta.url).pathname;

void Bun.plugin(imConsolePlugin({ runtimeSpecifier }));
