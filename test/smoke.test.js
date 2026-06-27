import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "build",
  "index.js",
);

const READY_LINE = "FreshRSS MCP server running on stdio";

/** Build an env that strips any inherited FRESHRSS_* vars, then applies overrides. */
function cleanEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("FRESHRSS_")) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

/**
 * Spawn the built server and resolve with its exit code and collected stderr.
 * On success the server stays alive on stdio, so we terminate it as soon as it
 * logs the ready line (or after a timeout).
 */
function runServer(overrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      env: cleanEnv(overrides),
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stderr, timedOut: true });
    }, 8000);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes(READY_LINE)) {
        child.kill("SIGTERM");
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => finish({ code, stderr, timedOut: false }));
  });
}

test("exits with an error when required env vars are missing", async () => {
  const { code, stderr } = await runServer({});
  assert.equal(code, 1, "should exit non-zero");
  assert.match(stderr, /environment variables are required/);
});

test("boots and logs the ready line when env vars are set", async () => {
  const { stderr } = await runServer({
    FRESHRSS_API_URL: "https://rss.example.com",
    FRESHRSS_USERNAME: "tester",
    FRESHRSS_API_PASSWORD: "api-password",
  });
  assert.match(stderr, new RegExp(READY_LINE));
});

test("accepts FRESHRSS_PASSWORD as a fallback for the API password", async () => {
  const { stderr } = await runServer({
    FRESHRSS_API_URL: "https://rss.example.com",
    FRESHRSS_USERNAME: "tester",
    FRESHRSS_PASSWORD: "api-password",
  });
  assert.match(stderr, new RegExp(READY_LINE));
});
