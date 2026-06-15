// Ensure a local tag-mapping config exists before dev/build/start.
// The real config (src/tagMapping.config.json) is git-ignored so each
// deployment keeps its own Discord tag / GitHub label names. On first run we
// seed it from the committed example template.
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src");
const configPath = path.join(srcDir, "tagMapping.config.json");
const examplePath = path.join(srcDir, "tagMapping.config.example.json");

if (fs.existsSync(configPath)) {
  process.exit(0);
}

if (!fs.existsSync(examplePath)) {
  console.error(
    "[ensureConfig] Missing src/tagMapping.config.example.json; cannot create a config.",
  );
  process.exit(1);
}

fs.copyFileSync(examplePath, configPath);
console.log(
  "[ensureConfig] Created src/tagMapping.config.json from the example template. " +
    "Edit it to match your Discord forum tags and GitHub labels.",
);
