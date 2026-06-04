// Preload referenced by this directory's bunfig.toml. Identical wiring to the
// top-level preload fixture, but reached via bunfig rather than a CLI flag.
import { imConsolePlugin } from "../../../src/bun/index.ts";

const runtimeSpecifier = new URL("../../../src/runtime/index.ts", import.meta.url).pathname;

void Bun.plugin(imConsolePlugin({ runtimeSpecifier }));
