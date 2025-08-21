#!/usr/bin/env node
const fs = require("fs");
const p = ".ai/out/packet.md";
if (!fs.existsSync(p)) process.exit(0);
const txt = fs.readFileSync(p, "utf8");
const chunks = (txt.match(/--- CHUNK \d+ ---/g) || []).length;
const tokensApprox = Math.ceil(txt.split(/\s+/).length * 1.3);
if (chunks > 15) { console.error(`❌ Packet has ${chunks} chunks (max 15).`); process.exit(1); }
if (tokensApprox > 8000) { console.error(`❌ Packet ~${tokensApprox} tokens (max ~8000).`); process.exit(1); }
console.log("✅ Packet budget OK.");
