#!/usr/bin/env node
process.env.AGENT_DOCK_ENTRYPOINT = "codex";
await import("../dist/src/index.js");
