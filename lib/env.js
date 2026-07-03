// Minimal .env parser — no dotenv dependency.
// Reads KEY=VALUE lines from .env in the project root, ignores comments/blanks.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ENV_PATH = path.join(__dirname, "..", ".env");

function loadEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  }
  // Real environment variables take precedence over .env file values.
  return { ...env, ...process.env };
}

// Append or replace a KEY=VALUE line in .env. Used to persist generated
// device keys and deployed contract addresses without ever printing them.
function saveEnvVar(key, value) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += line + "\n";
  }
  fs.writeFileSync(ENV_PATH, content, "utf8");
}

module.exports = { loadEnv, saveEnvVar, ENV_PATH };
