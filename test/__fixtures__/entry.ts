// Entry file that `bun` runs directly. It only imports `greet`; the
// `import.meta.console` calls live in the imported module, exercising the
// "transform applies to imported files too" behaviour.
import { greet } from "./greet.ts";

greet("world");

// And one call in the entry itself, to prove the entry is transformed too.
import.meta.console.error("from entry");
