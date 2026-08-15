/**
 * Email transport tests (no network, no real emails).
 * Run: node --test scripts/test-email.js
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-placeholder";
process.env.NODE_ENV = "test";
process.env.EMAIL_PROVIDER = "resend";
process.env.RESEND_API_KEY = "re_test_key_not_real";
process.env.EMAIL_FROM = "Resume Evaluator <updates@example.com>";
process.env.FRONTEND_URL = "https://resume-analysis-b7p7.onrender.com";

const emailService = require("../src/services/emailService");

const sampleInterview = {
    id: "interview-abc",
    candidateEmail: "candidate@example.com",
    candidateName: "Test Candidate",
    date: "2026-08-20",
    time: "10:00",
    timezone: "UTC",
    durationMinutes: 25,
    jobRole: "Software Engineer",
};

function captureLogs(fn) {
    const lines = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    const push = (...args) => lines.push(args.map(String).join(" "));
    console.log = push;
    console.error = push;
    console.warn = push;
    return Promise.resolve()
        .then(fn)
        .finally(() => {
            console.log = originalLog;
            console.error = originalError;
            console.warn = originalWarn;
        })
        .then((result) => ({ result, lines: lines.join("\n") }));
}

beforeEach(() => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.RESEND_API_KEY = "re_test_key_not_real";
    process.env.EMAIL_FROM = "Resume Evaluator <updates@example.com>";
    process.env.FRONTEND_URL = "https://resume-analysis-b7p7.onrender.com";
    process.env.NODE_ENV = "test";
    emailService.__resetEmailServiceForTests();
});

afterEach(() => {
    emailService.__resetEmailServiceForTests();
});

describe("Resend invitation transport", () => {
    it("calls the transactional provider for candidate invitations", async () => {
        const calls = [];
        emailService.__setEmailTransportForTests(async (mail) => {
            calls.push(mail);
            return { messageId: "re_msg_invite_1", response: { id: "re_msg_invite_1" } };
        });

        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(result.sent, true);
        assert.equal(result.success, true);
        assert.equal(result.messageId, "re_msg_invite_1");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].provider, "resend");
        assert.match(calls[0].html, /Join Interview/);
        assert.match(
            calls[0].html,
            /https:\/\/resume-analysis-b7p7\.onrender\.com\/candidate-interview\/interview-abc/
        );
        assert.equal(emailService.__didCreateSmtpTransporter(), false);
    });

    it("marks email sent only after a provider message id is returned", async () => {
        emailService.__setEmailTransportForTests(async () => ({ response: {} }));
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(result.sent, false);
        assert.equal(result.success, false);
    });

    it("does not report sent when the provider rejects the invitation", async () => {
        emailService.__setEmailTransportForTests(async () => {
            throw new emailService.EmailSendError("provider rejected", {
                retryable: false,
                statusCode: 403,
            });
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(result.sent, false);
        assert.equal(result.success, false);
        assert.match(result.error, /provider rejected/i);
    });
});

describe("Resend reminder transport", () => {
    it("calls the transactional provider for reminders", async () => {
        const calls = [];
        emailService.__setEmailTransportForTests(async (mail) => {
            calls.push(mail);
            return { messageId: "re_msg_reminder_1", response: { id: "re_msg_reminder_1" } };
        });

        const result = await emailService.sendInterviewReminder(sampleInterview, "30m");
        assert.equal(result.success, true);
        assert.equal(result.messageId, "re_msg_reminder_1");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].provider, "resend");
        assert.match(calls[0].subject, /30 Minutes/);
        assert.equal(emailService.__didCreateSmtpTransporter(), false);
    });
});

describe("email configuration and safety", () => {
    it("fails safely when the Resend API key is missing", async () => {
        delete process.env.RESEND_API_KEY;
        emailService.__setEmailTransportForTests(async () => {
            throw new Error("should not send");
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(emailService.isEmailConfigured(), false);
        assert.equal(result.sent, false);
        assert.match(result.error, /RESEND_API_KEY/);
    });

    it("does not invoke Gmail SMTP when EMAIL_PROVIDER=resend", async () => {
        process.env.EMAIL_USER = "local@gmail.com";
        process.env.EMAIL_PASSWORD = "not-a-real-app-password";
        emailService.__setEmailTransportForTests(async () => ({
            messageId: "re_msg_no_smtp",
            response: { id: "re_msg_no_smtp" },
        }));
        await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(emailService.getEmailProvider(), "resend");
        assert.equal(emailService.__didCreateSmtpTransporter(), false);
        const verified = await emailService.ensureTransporterVerified();
        assert.equal(verified, true);
        assert.equal(emailService.__didCreateSmtpTransporter(), false);
    });

    it("never logs the API key", async () => {
        const { lines } = await captureLogs(async () => {
            emailService.__setEmailTransportForTests(async () => ({
                messageId: "re_msg_log",
                response: { id: "re_msg_log" },
            }));
            await emailService.sendScheduledInterviewInvite(sampleInterview);
            emailService.warnIfEmailEnvMissing();
            console.error(
                emailService.sanitizeEmailError(
                    new Error("failed RESEND_API_KEY=re_live_should_not_appear")
                )
            );
        });
        assert.doesNotMatch(lines, /re_test_key_not_real|re_live_should_not_appear/);
        assert.match(lines, /Provider: resend/);
    });

    it("keeps the candidate join URL on the configured frontend path", async () => {
        const url = emailService.resolveCandidateInterviewUrl(sampleInterview);
        assert.equal(
            url,
            "https://resume-analysis-b7p7.onrender.com/candidate-interview/interview-abc"
        );
    });
});

describe("retry behavior", () => {
    it("retries retryable provider errors", async () => {
        let attempts = 0;
        emailService.__setEmailTransportForTests(async () => {
            attempts += 1;
            if (attempts < 3) {
                throw new emailService.EmailSendError("Connection timeout", {
                    retryable: true,
                    statusCode: 503,
                });
            }
            return { messageId: "re_msg_retry", response: { id: "re_msg_retry" } };
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(attempts, 3);
        assert.equal(result.sent, true);
        assert.equal(result.messageId, "re_msg_retry");
    });

    it("does not retry permanent configuration errors", async () => {
        let attempts = 0;
        emailService.__setEmailTransportForTests(async () => {
            attempts += 1;
            throw new emailService.EmailSendError("invalid api key", {
                retryable: false,
                statusCode: 401,
            });
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(attempts, 1);
        assert.equal(result.sent, false);
    });

    it("classifies 429/5xx as retryable and 401/422 as permanent", () => {
        assert.equal(emailService.isRetryableEmailError({ statusCode: 429 }), true);
        assert.equal(emailService.isRetryableEmailError({ statusCode: 500 }), true);
        assert.equal(emailService.isRetryableEmailError({ statusCode: 504 }), true);
        assert.equal(emailService.isRetryableEmailError({ code: "ETIMEDOUT" }), true);
        assert.equal(emailService.isRetryableEmailError({ statusCode: 401 }), false);
        assert.equal(emailService.isRetryableEmailError({ statusCode: 422 }), false);
        assert.equal(
            emailService.isRetryableEmailError(
                new emailService.EmailSendError("missing api key", { retryable: false })
            ),
            false
        );
    });
});

describe("interview remains scheduled after email failure", () => {
    it("returns a failure result without throwing so the interview is kept", async () => {
        emailService.__setEmailTransportForTests(async () => {
            throw new emailService.EmailSendError("provider down", {
                retryable: true,
                statusCode: 502,
            });
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(result.sent, false);
        assert.equal(result.success, false);
        assert.ok(result.error);
    });
});

describe("Gmail SMTP IPv4 transport", () => {
    function useGmailEnv() {
        process.env.EMAIL_PROVIDER = "gmail";
        process.env.EMAIL_USER = "sender@gmail.com";
        process.env.EMAIL_PASSWORD = "not-a-real-app-password";
        delete process.env.RESEND_API_KEY;
        emailService.__resetEmailServiceForTests();
    }

    it("configures the Nodemailer transporter to prefer IPv4", () => {
        useGmailEnv();
        emailService.__createSmtpTransporterForTests();
        const opts = emailService.__getLastSmtpTransportOptions();
        assert.equal(emailService.getEmailProvider(), "gmail");
        assert.equal(opts.host, "smtp.gmail.com");
        assert.equal(opts.port, 587);
        assert.equal(opts.secure, false);
        assert.equal(opts.family, 4);
        assert.equal(opts.requireTLS, true);
        assert.equal(opts.hasGetSocket, true);
        assert.equal(opts.tlsServername, "smtp.gmail.com");
        assert.equal(emailService.getSmtpConfig().family, 4);
    });

    it("defaults to Gmail even in production when EMAIL_PROVIDER is unset", () => {
        delete process.env.EMAIL_PROVIDER;
        process.env.NODE_ENV = "production";
        process.env.RENDER = "true";
        assert.equal(emailService.getEmailProvider(), "gmail");
        delete process.env.RENDER;
    });

    it("sets sent only after sendMail succeeds", async () => {
        useGmailEnv();
        emailService.__setEmailTransportForTests(async () => ({
            messageId: "gmail-msg-1",
            response: "250 2.0.0 OK",
            accepted: ["candidate@example.com"],
        }));
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(result.sent, true);
        assert.equal(result.success, true);
        assert.equal(result.messageId, "gmail-msg-1");
        assert.equal(emailService.__didCreateSmtpTransporter(), false);
    });

    it("does not set sent when SMTP sendMail fails", async () => {
        useGmailEnv();
        const err = new Error("connect ENETUNREACH 2404:6800:4003:c00::6d:587");
        err.code = "ENETUNREACH";
        emailService.__setEmailTransportForTests(async () => {
            throw err;
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(result.sent, false);
        assert.equal(result.success, false);
        assert.match(result.error || "", /ENETUNREACH|connect/i);
    });

    it("retries retryable SMTP failures then marks sent after success", async () => {
        useGmailEnv();
        let attempts = 0;
        emailService.__setEmailTransportForTests(async () => {
            attempts += 1;
            if (attempts < 2) {
                const timeout = new Error("Connection timeout");
                timeout.code = "ETIMEDOUT";
                throw timeout;
            }
            return { messageId: "gmail-retry-ok", response: "250 OK" };
        });
        const result = await emailService.sendScheduledInterviewInvite(sampleInterview);
        assert.equal(attempts, 2);
        assert.equal(result.sent, true);
        assert.equal(result.messageId, "gmail-retry-ok");
    });

    it("keeps reminder success tied to sendMail and does not create SMTP during mocked send", async () => {
        useGmailEnv();
        const calls = [];
        emailService.__setEmailTransportForTests(async (mail) => {
            calls.push(mail);
            return { messageId: "gmail-reminder-1", response: "250 OK" };
        });
        const result = await emailService.sendInterviewReminder(sampleInterview, "30m");
        assert.equal(result.success, true);
        assert.equal(result.messageId, "gmail-reminder-1");
        assert.equal(calls.length, 1);
        assert.equal(calls[0].provider, "gmail");
        assert.match(calls[0].subject, /30 Minutes/);
        assert.equal(emailService.__didCreateSmtpTransporter(), false);
    });
});
