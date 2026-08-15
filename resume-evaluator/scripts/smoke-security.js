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

const emailService = require("../src/services/emailService");

assert(emailService.isValidEmail("candidate@example.com") === true, "accepts valid candidate email");
assert(emailService.isValidEmail("") === false, "rejects missing candidate email");
assert(emailService.isValidEmail("Not Provided") === false, "rejects placeholder email");
assert(emailService.isValidEmail("john@") === false, "rejects invalid email");

const previousFrontend = process.env.FRONTEND_URL;
const previousNodeEnv = process.env.NODE_ENV;
process.env.FRONTEND_URL = "https://resume-analysis-b7p7.onrender.com";
process.env.NODE_ENV = "production";
const candidateUrl = emailService.resolveCandidateInterviewUrl({
    id: "interview-123",
    meetingLink: "http://localhost:4200/candidate-interview/interview-123",
});
assert(
    candidateUrl === "https://resume-analysis-b7p7.onrender.com/candidate-interview/interview-123",
    "rebuilds production candidate URL instead of localhost"
);
assert(candidateUrl.includes("/candidate-interview/interview-123"), "uses candidate-interview path");
assert(!candidateUrl.includes("localhost"), "does not email localhost URLs in production");

if (previousFrontend == null) {
    delete process.env.FRONTEND_URL;
} else {
    process.env.FRONTEND_URL = previousFrontend;
}
process.env.NODE_ENV = previousNodeEnv;

const smtp = emailService.getSmtpConfig();
assert(smtp.host === "smtp.gmail.com", "defaults SMTP host to Gmail");
assert(smtp.port === 587, "defaults SMTP port to 587");
assert(smtp.secure === false, "defaults SMTP secure=false for STARTTLS");

(async () => {
    const missing = await emailService.sendScheduledInterviewInvite({
        id: "interview-missing-email",
        candidateEmail: "",
    });
    assert(missing.sent === false, "missing candidate email does not report sent");
    assert(Boolean(missing.error), "missing candidate email returns an error");

    const invalid = await emailService.sendScheduledInterviewInvite({
        id: "interview-invalid-email",
        candidateEmail: "not-an-email",
    });
    assert(invalid.sent === false, "invalid candidate email does not report sent");

    const previousUser = process.env.EMAIL_USER;
    const previousPassword = process.env.EMAIL_PASSWORD;
    const previousProvider = process.env.EMAIL_PROVIDER;
    const previousResend = process.env.RESEND_API_KEY;
    const previousFrom = process.env.EMAIL_FROM;
    delete process.env.EMAIL_USER;
    delete process.env.EMAIL_PASSWORD;
    process.env.EMAIL_PROVIDER = "gmail";
    assert(emailService.isEmailConfigured() === false, "detects SMTP not configured");
    const unconfigured = await emailService.sendScheduledInterviewInvite({
        id: "interview-unconfigured",
        candidateEmail: "candidate@example.com",
        candidateName: "Test Candidate",
        date: "2026-08-20",
        time: "10:00",
        timezone: "UTC",
        durationMinutes: 25,
    });
    assert(unconfigured.sent === false, "unconfigured SMTP does not report sent");

    process.env.EMAIL_PROVIDER = "resend";
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    assert(emailService.isEmailConfigured() === false, "detects Resend not configured");
    const unconfiguredResend = await emailService.sendScheduledInterviewInvite({
        id: "interview-unconfigured-resend",
        candidateEmail: "candidate@example.com",
        candidateName: "Test Candidate",
        date: "2026-08-20",
        time: "10:00",
        timezone: "UTC",
        durationMinutes: 25,
    });
    assert(unconfiguredResend.sent === false, "unconfigured Resend does not report sent");
    assert(/RESEND_API_KEY/i.test(unconfiguredResend.error || ""), "missing Resend key returns a clear error");

    if (previousUser == null) delete process.env.EMAIL_USER;
    else process.env.EMAIL_USER = previousUser;
    if (previousPassword == null) delete process.env.EMAIL_PASSWORD;
    else process.env.EMAIL_PASSWORD = previousPassword;
    if (previousProvider == null) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = previousProvider;
    if (previousResend == null) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousResend;
    if (previousFrom == null) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;

    const leaked = emailService.sanitizeEmailError(
        new Error("SMTP auth failed password=supersecret EMAIL_PASSWORD=abcd API_KEY=xyz RESEND_API_KEY=re_secretkey smtp://user:hunter2@smtp.gmail.com")
    );
    assert(!/supersecret|hunter2|abcd|xyz|re_secretkey/.test(leaked), "sanitizes SMTP credentials from email errors");
    assert(/redacted/i.test(leaked), "marks redacted credential material");

    console.log("All smoke-security checks passed.");
})().catch((err) => {
    console.error("FAIL:", err.message || err);
    process.exit(1);
});
