// dist is exclusively tsconfig's generated output; clean it so removed modules
// from earlier layouts cannot survive a successful build. No runtime data lives here.
import { rm } from "node:fs/promises";
await rm(new URL("../../dist/", import.meta.url), { recursive: true, force: true });
