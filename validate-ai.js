#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const Ajv = require("ajv");
const { execSync } = require("child_process");

const indexPath = path.resolve(".ai/AI_INDEX.yml");
const schemaPath = path.resolve(".ai/schemas/ai_index.schema.json");

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8" }).trim(); }
  catch { return ""; }
}

if (!fs.existsSync(indexPath)) { console.error("❌ Missing .ai/AI_INDEX.yml"); process.exit(1); }
const doc = yaml.load(fs.readFileSync(indexPath, "utf8"));
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
if (!validate(doc)) {
  console.error("❌ AI_INDEX.yml schema errors:", validate.errors);
  process.exit(1);
}

let files = sh(process.env.CI
  ? `git diff --name-only ${process.env.GITHUB_BASE_REF || "origin/main"}`
  : `git diff --cached --name-only`
).split("\n").filter(Boolean);

const touched = new Set();
for (const f of files) {
  const seg = f.split(path.sep);
  const key = seg.slice(0, 2).join("/"); // e.g. apps/foo or packages/bar
  if (doc.packages && doc.packages[key]) touched.add(key);
}

const missing = [];
for (const p of touched) {
  const entry = doc.packages[p];
  if (!entry.owners || entry.owners.length === 0) missing.push(`[${p}] owners`);
  if (!entry.invariants || entry.invariants.length === 0) missing.push(`[${p}] invariants`);
}

if (missing.length) {
  console.error("❌ Missing required fields in AI_INDEX.yml:");
  for (const m of missing) console.error("  - " + m);
  process.exit(1);
}

console.log("✅ AI index validated.");
