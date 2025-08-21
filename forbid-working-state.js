#!/usr/bin/env node
const fs = require("fs");
const bad = [".ai/working-state.json", ".ai/out/packet.md"];
const found = bad.filter((p) => fs.existsSync(p));
if (found.length) {
  console.error("❌ Do not commit task-local or packet outputs:");
  for (const f of found) console.error("  - " + f);
  process.exit(1);
}
