#!/usr/bin/env node
process.argv.splice(2, 0, "--dev");
await import("./heptapod-web.mjs");
