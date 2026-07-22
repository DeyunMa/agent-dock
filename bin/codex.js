#!/usr/bin/env node
process.env.CODEX_ROUTER_ENTRYPOINT = "codex";
await import("../dist/src/index.js");
