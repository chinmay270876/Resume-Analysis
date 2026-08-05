/**
 * Offline smoke checks for path sanitization (no network, no real secrets).
 * Run: node scripts/smoke-security.js
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-placeholder";
process.env.NODE_ENV = "development";

const path = require("path");
const fs = require("fs");
const {
    resolveAudioAbsolutePath,
    sanitizeAudioFilePath,
} = require("../src/services/podcastTranscriptService");

function assert(cond, msg) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exit(1);
    }
    console.log("OK:", msg);
}

assert(resolveAudioAbsolutePath("../../../etc/passwd") == null, "blocks relative traversal");
assert(sanitizeAudioFilePath("../../../etc/passwd") == null, "sanitize blocks traversal");
assert(
    sanitizeAudioFilePath(path.join(process.cwd(), "package.json")) == null,
    "sanitize blocks files outside media dirs"
);

fs.mkdirSync(path.join(process.cwd(), "output"), { recursive: true });
const sample = path.join(process.cwd(), "output", "smoke-test.mp3");
fs.writeFileSync(sample, "x");
assert(Array.isArray(resolveAudioAbsolutePath("output/smoke-test.mp3")), "allows output media");
assert(sanitizeAudioFilePath("output/smoke-test.mp3") === "output/smoke-test.mp3", "sanitizes to relative");
fs.unlinkSync(sample);

console.log("All smoke-security checks passed.");
