/**
 * Side-effect entry for zero-config preloading. Add to `bunfig.toml`:
 *
 *   preload = ["im.console/bun/preload"]
 *
 * Importing this module registers the `import.meta.console` transform against
 * the active Bun runtime with default options (runtime imported from
 * `im.console/runtime`).
 */
import { imConsolePlugin } from "./index.ts";

void Bun.plugin(imConsolePlugin());
