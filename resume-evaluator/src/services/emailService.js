const { performance } = require("perf_hooks");
const nodemailer = require("nodemailer");
const { Resend } = require("resend");
const { escapeHtml, sanitizeHttpUrl } = require("../utils/htmlEscape");

// RFC-5322-lite: good enough to reject obvious garbage like "Not Provided",
// "N/A", "john@" or "plainstring" while accepting real addresses.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SMTP_HOST = "smtp.gmail.com";
const DEFAULT_SMTP_PORT = 587;
const MAX_SEND_ATTEMPTS = 3;
const SMTP_CONNECTION_TIMEOUT_MS = 8000;
const SMTP_GREETING_TIMEOUT_MS = 8000;
const SMTP_SOCKET_TIMEOUT_MS = 15000;
const PRODUCTION_FRONTEND_FALLBACK = "https://resume-analysis-b7p7.onrender.com";
const PROVIDER_RESEND = "resend";
const PROVIDER_GMAIL = "gmail";

function isLocalOrDevHostname(hostname) {
    const host = String(hostname || "").toLowerCase();
    return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.endsWith(".local")
    );
}

function isApiHostname(hostname) {
    const candidates = [process.env.RENDER_EXTERNAL_URL, process.env.BACKEND_PUBLIC_URL];
    for (const raw of candidates) {
        if (!raw) continue;
        try {
            if (new URL(raw).hostname.toLowerCase() === String(hostname || "").toLowerCase()) {
                return true;
            }
        } catch {
            // ignore invalid public API URLs
        }
    }
    return /(?:^|\.)resume-analysis-api/i.test(String(hostname || ""));
}

function isUsablePublicFrontendUrl(value) {
    const sanitized = sanitizeHttpUrl(value);
    if (!sanitized) return false;
    try {
        const parsed = new URL(sanitized);
        if (isLocalOrDevHostname(parsed.hostname)) return false;
        if (isApiHostname(parsed.hostname)) return false;
        return true;
    } catch {
        return false;
    }
}

function resolveFrontendBaseUrl() {
    const configured = String(process.env.FRONTEND_URL || "").trim();
    if (isUsablePublicFrontendUrl(configured)) {
        return configured.replace(/\/$/, "");
    }

    const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
    if (isProd && !configured) {
        console.error("[EMAIL] FRONTEND_URL is not configured in production");
    } else if (isProd && configured && !isUsablePublicFrontendUrl(configured)) {
        console.error("[EMAIL] FRONTEND_URL is not a usable public frontend URL");
    }

    const corsBase = String(process.env.CORS_ORIGINS || "")
        .split(",")
        .map((part) => part.trim())
        .find((part) => isUsablePublicFrontendUrl(part));
    if (corsBase) {
        return corsBase.replace(/\/$/, "");
    }

    if (isProd) {
        return PRODUCTION_FRONTEND_FALLBACK;
    }

    return "http://localhost:4200";
}

function resolveCandidateInterviewUrl(interview) {
    const fromRecord = sanitizeHttpUrl(interview?.meetingLink || "");
    if (fromRecord) {
        const rewritten = fromRecord.replace(/\/interviews\/([^/?#]+)/, "/candidate-interview/$1");
        const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
        if (!isProd || isUsablePublicFrontendUrl(rewritten)) {
            return rewritten;
        }
    }
    if (interview?.id) {
        return `${resolveFrontendBaseUrl()}/candidate-interview/${interview.id}`;
    }
    return "";
}

/**
 * Validates an email address. Returns false for missing, placeholder, or
 * syntactically invalid addresses. Never throws.
 */
function isValidEmail(email) {
    if (typeof email === "string" && /[\r\n]/.test(email)) {
        return false;
    }
    if (typeof email !== "string") {
        return false;
    }
    const normalized = email.trim();
    if (normalized.length === 0) {
        return false;
    }
    if (/^(not\s*provided|n\/?a|null|none|unknown|undefined)$/i.test(normalized)) {
        return false;
    }
    return EMAIL_REGEX.test(normalized);
}

let transporter;
let transporterVerified = false;
let smtpTransporterCreated = false;
let resendClient = null;
let testTransport = null;

class EmailSendError extends Error {
    constructor(message, { retryable = false, statusCode = null, code = null } = {}) {
        super(message);
        this.name = "EmailSendError";
        this.retryable = retryable;
        this.statusCode = statusCode;
        this.code = code;
    }
}

function isProductionRuntime() {
    return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
}

function getEmailProvider() {
    const raw = String(process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
    if (raw === PROVIDER_RESEND || raw === PROVIDER_GMAIL) {
        return raw;
    }
    // Production must not silently depend on Gmail SMTP connectivity.
    if (isProductionRuntime()) {
        return PROVIDER_RESEND;
    }
    return PROVIDER_GMAIL;
}

function getResendApiKey() {
    return String(process.env.RESEND_API_KEY || "").trim();
}

function getEmailCredentials() {
    const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
    // Gmail app passwords are often pasted with spaces — strip them for SMTP auth.
    const EMAIL_PASS = String(process.env.EMAIL_PASSWORD || "").replace(/\s+/g, "");
    return { EMAIL_USER, EMAIL_PASS };
}

function getConfiguredFromAddress() {
    const from = String(process.env.EMAIL_FROM || "").trim();
    if (from) return from;
    if (getEmailProvider() === PROVIDER_GMAIL) {
        return (process.env.EMAIL_USER || "").trim();
    }
    return "";
}

function isSafeAddressHeader(value) {
    return typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);
}

function isEmailConfigured() {
    const provider = getEmailProvider();
    if (provider === PROVIDER_RESEND) {
        return Boolean(getResendApiKey() && getConfiguredFromAddress());
    }
    const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();
    return Boolean(EMAIL_USER && EMAIL_PASS);
}

function getEmailConfigError() {
    const provider = getEmailProvider();
    if (provider === PROVIDER_RESEND) {
        if (!getResendApiKey()) {
            return "RESEND_API_KEY is not configured";
        }
        if (!getConfiguredFromAddress()) {
            return "EMAIL_FROM is not configured for the Resend provider";
        }
        return null;
    }
    const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();
    if (!EMAIL_USER || !EMAIL_PASS) {
        return "EMAIL_USER and EMAIL_PASSWORD are not configured";
    }
    return null;
}

function sanitizeEmailError(error) {
    const raw = error && typeof error === "object" ? error.message : String(error || "Email send failed");
    return String(raw)
        .replace(/\/\/([^/@\s]+):([^@/\s]+)@/g, "//$1:<redacted>@")
        .replace(
            /\b(EMAIL_PASSWORD|SMTP_PASS(?:WORD)?|SMTP_PASSWORD|RESEND_API_KEY|OPENAI_API_KEY|HMS_APP_SECRET|HMS_WEBHOOK_SECRET|AUTH(?:ENTICATION)?[_-]?TOKEN|API[_-]?KEY|BEARER)\b\s*[=:]\s*\S+/gi,
            "$1=<redacted>"
        )
        .replace(/pass(?:word)?[=:]\s*[^,\s]+/gi, "password=<redacted>")
        .replace(/\bre_[A-Za-z0-9]+\b/g, "<redacted>")
        .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "<redacted>")
        .replace(/\b[A-Za-z0-9]{16}\b/g, "<redacted>")
        .slice(0, 240);
}

function getSmtpConfig() {
    const host = (process.env.SMTP_HOST || DEFAULT_SMTP_HOST).trim();
    const portRaw = Number(process.env.SMTP_PORT);
    const port = Number.isFinite(portRaw) && portRaw > 0 ? Math.floor(portRaw) : DEFAULT_SMTP_PORT;
    const secureEnv = String(process.env.SMTP_SECURE || "").toLowerCase();
    const secure =
        secureEnv === "true" || secureEnv === "1"
            ? true
            : secureEnv === "false" || secureEnv === "0"
                ? false
                : port === 465;
    return { host, port, secure };
}

function getPublicEmailStatus() {
    return {
        provider: getEmailProvider(),
        configured: isEmailConfigured(),
    };
}

/**
 * Startup validation — logs warnings for missing email env vars.
 * Does not throw; scheduling must keep working without email.
 * Does not send a test email and does not call a live provider API.
 */
function warnIfEmailEnvMissing() {
    const provider = getEmailProvider();
    const fromConfigured = Boolean(getConfiguredFromAddress());
    console.log(`[EMAIL] Provider configured: ${provider}`);
    console.log(`[EMAIL] FRONTEND_URL configured: ${Boolean(String(process.env.FRONTEND_URL || "").trim())}`);

    if (provider === PROVIDER_RESEND) {
        console.log(`[EMAIL] API key configured: ${Boolean(getResendApiKey())}`);
        console.log(`[EMAIL] Sender configured: ${fromConfigured}`);
        if (!getResendApiKey()) {
            console.warn(
                "[EMAIL] STARTUP WARNING: Missing required env var: RESEND_API_KEY. " +
                    "Invitation and reminder emails will fail until configured."
            );
        }
        if (!fromConfigured) {
            console.warn(
                "[EMAIL] STARTUP WARNING: Missing required env var: EMAIL_FROM. " +
                    "Use a Resend-verified sender, e.g. Resume Evaluator <verified@your-domain.com>."
            );
        }
        return;
    }

    const { host, port } = getSmtpConfig();
    const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();
    const hostConfigured = Boolean(String(process.env.SMTP_HOST || host || "").trim());

    console.log(`[EMAIL] SMTP configured: ${isEmailConfigured()}`);
    console.log(`[EMAIL] SMTP host configured: ${hostConfigured}`);
    console.log(`[EMAIL] SMTP user configured: ${Boolean(EMAIL_USER)}`);
    console.log(`[EMAIL] SMTP password configured: ${Boolean(EMAIL_PASS)}`);
    console.log(`[EMAIL] SMTP port configured: ${Boolean(port)}`);

    if (!EMAIL_USER || !EMAIL_PASS) {
        console.warn(
            "[EMAIL] STARTUP WARNING: Missing required env vars: EMAIL_USER and/or EMAIL_PASSWORD. " +
                "Invitation and reminder emails will fail until configured."
        );
    }
    if (!String(process.env.SMTP_HOST || "").trim()) {
        console.warn(
            "[EMAIL] STARTUP WARNING: SMTP_HOST unset. Using default smtp.gmail.com:587 with STARTTLS."
        );
    }
}

function getTransporter() {
    if (getEmailProvider() === PROVIDER_RESEND) {
        throw new EmailSendError("Gmail SMTP is disabled while EMAIL_PROVIDER=resend", {
            retryable: false,
        });
    }

    if (!transporter) {
        const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();

        if (!EMAIL_USER || !EMAIL_PASS) {
            throw new EmailSendError(
                "Email credentials (EMAIL_USER, EMAIL_PASSWORD) are not configured",
                { retryable: false }
            );
        }

        const { host, port, secure } = getSmtpConfig();

        console.log(
            `[EMAIL] Creating SMTP transporter hostConfigured=true portConfigured=true ` +
                `secure=${secure} userConfigured=true passwordConfigured=true`
        );

        smtpTransporterCreated = true;
        transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            requireTLS: !secure && port === 587,
            auth: {
                user: EMAIL_USER,
                pass: EMAIL_PASS,
            },
            family: 4,
            connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
            greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
            socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
            tls: {
                minVersion: "TLSv1.2",
            },
        });
    }
    return transporter;
}

async function ensureTransporterVerified() {
    if (getEmailProvider() === PROVIDER_RESEND) {
        return true;
    }
    if (transporterVerified) return true;
    try {
        const t = getTransporter();
        await t.verify();
        transporterVerified = true;
        console.log("[EMAIL] SMTP transporter verification successful");
        return true;
    } catch (err) {
        console.error("[EMAIL] SMTP transporter verification failed:", sanitizeEmailError(err));
        if (err.code) console.error(`[EMAIL] SMTP verify code: ${err.code}`);
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEmailError(error) {
    if (!error) return false;
    if (error.retryable === false) return false;
    if (error.retryable === true) return true;

    const status = Number(error.statusCode || error.status);
    if ([429, 500, 502, 503, 504].includes(status)) return true;
    if ([400, 401, 403, 404, 422].includes(status)) return false;

    const code = String(error.code || "").toUpperCase();
    if (["EAUTH", "EENVELOPE", "EMESSAGE"].includes(code)) return false;
    if (
        [
            "ETIMEDOUT",
            "ESOCKET",
            "ECONNECTION",
            "ENETUNREACH",
            "ECONNRESET",
            "ECONNREFUSED",
            "EAI_AGAIN",
            "UND_ERR_CONNECT_TIMEOUT",
            "UND_ERR_SOCKET",
        ].includes(code)
    ) {
        return true;
    }

    const message = String(error.message || "").toLowerCase();
    if (
        message.includes("invalid api key") ||
        message.includes("missing api key") ||
        message.includes("unauthorized") ||
        message.includes("forbidden") ||
        message.includes("invalid from") ||
        message.includes("invalid recipient") ||
        message.includes("validation")
    ) {
        return false;
    }
    return (
        message.includes("timeout") ||
        message.includes("timed out") ||
        message.includes("rate limit") ||
        message.includes("temporar") ||
        message.includes("network")
    );
}

function classifyResendError(error, label = "Email") {
    const statusCode = Number(error?.statusCode || error?.status) || null;
    const message = sanitizeEmailError(error?.message || `${label} was rejected by provider`);
    return new EmailSendError(message, {
        retryable: isRetryableEmailError({ ...error, statusCode, message }),
        statusCode,
        code: error?.name || error?.code || null,
    });
}

function assertSmtpAccepted(info, label = "Email") {
    const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    if (rejected.length > 0 && accepted.length === 0) {
        throw new EmailSendError(`${label} was rejected by SMTP`, { retryable: false });
    }
    if (accepted.length === 0 && !info?.messageId) {
        throw new EmailSendError(`${label} was not accepted by SMTP`, { retryable: true });
    }
    return info;
}

function getResendClient() {
    const apiKey = getResendApiKey();
    if (!apiKey) {
        throw new EmailSendError("RESEND_API_KEY is not configured", { retryable: false });
    }
    if (!resendClient) {
        resendClient = new Resend(apiKey);
    }
    return resendClient;
}

async function sendViaResend(mailOptions, label) {
    const from = getConfiguredFromAddress();
    if (!isSafeAddressHeader(from)) {
        throw new EmailSendError("EMAIL_FROM is missing or invalid", { retryable: false });
    }
    if (!isValidEmail(mailOptions.to)) {
        throw new EmailSendError("Recipient email is missing or invalid", { retryable: false });
    }

    const client = getResendClient();
    const { data, error } = await client.emails.send({
        from,
        to: [mailOptions.to],
        subject: mailOptions.subject,
        html: mailOptions.html,
    });

    if (error) {
        throw classifyResendError(error, label);
    }
    if (!data?.id) {
        throw new EmailSendError(`${label} was not accepted by provider`, { retryable: true });
    }
    return { messageId: data.id, response: data };
}

async function sendViaGmail(mailOptions, label) {
    const t = getTransporter();
    const info = assertSmtpAccepted(await t.sendMail(mailOptions), label);
    return {
        messageId: info.messageId,
        response: info.response,
        accepted: info.accepted,
        rejected: info.rejected,
    };
}

async function sendWithRetry(sendOnce, label = "Email") {
    let lastError;

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
            console.log(`[EMAIL] ${label} attempt ${attempt}/${MAX_SEND_ATTEMPTS}`);
            return await sendOnce();
        } catch (err) {
            lastError = err;
            console.error(
                `[EMAIL] ${label} attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${sanitizeEmailError(err)}`
            );
            if (attempt < MAX_SEND_ATTEMPTS && isRetryableEmailError(err)) {
                const delayMs = Math.pow(2, attempt - 1) * 1000;
                console.log(`[EMAIL] Retrying ${label} in ${delayMs}ms...`);
                await sleep(delayMs);
                continue;
            }
            break;
        }
    }

    throw lastError;
}

async function deliverMail(mailOptions, label = "Email") {
    const provider = getEmailProvider();
    console.log(`[EMAIL] Provider: ${provider}`);

    if (typeof testTransport === "function") {
        return sendWithRetry(() => testTransport({ ...mailOptions, provider, label }), label);
    }

    if (provider === PROVIDER_RESEND) {
        const configError = getEmailConfigError();
        if (configError) {
            throw new EmailSendError(configError, { retryable: false });
        }
        return sendWithRetry(() => sendViaResend(mailOptions, label), label);
    }

    return sendWithRetry(() => sendViaGmail(mailOptions, label), label);
}

function resolveJobRole(interview) {
    if (typeof interview?.jobRole === "string" && interview.jobRole.trim()) {
        return interview.jobRole.trim();
    }
    const jd = interview?.jobDescription;
    if (jd && typeof jd === "object") {
        if (typeof jd.jobTitle === "string" && jd.jobTitle.trim()) return jd.jobTitle.trim();
        if (typeof jd.role === "string" && jd.role.trim()) return jd.role.trim();
    }
    const summary = interview?.resumeSummary;
    if (summary && typeof summary === "object") {
        if (typeof summary.role === "string" && summary.role.trim()) return summary.role.trim();
        if (typeof summary.roleTitle === "string" && summary.roleTitle.trim()) {
            return summary.roleTitle.trim();
        }
    }
    return "Not specified";
}

function resolveRecruiterContact() {
    const contact = (process.env.RECRUITER_CONTACT || process.env.EMAIL_USER || "").trim();
    return contact || "Recruitment Team";
}

function reminderLabel(reminderType) {
    const labels = {
        "24h": "24 Hours",
        "1h": "1 Hour",
        "30m": "30 Minutes",
        "10m": "10 Minutes",
    };
    return labels[reminderType] || "soon";
}

function buildMailFrom(fallbackUser) {
    const from = getConfiguredFromAddress() || fallbackUser || "";
    if (!isSafeAddressHeader(from)) {
        throw new EmailSendError("Sender address is missing or invalid", { retryable: false });
    }
    return from;
}

async function sendInterviewInvite(candidateName, candidateEmail, atsEvaluation) {
    // Phase 4: never attempt to send unless the address is real. Missing or
    // invalid emails must NOT throw - the pipeline continues normally.
    if (!isValidEmail(candidateEmail)) {
        console.warn(
            "Candidate email missing or invalid (" +
                JSON.stringify(candidateEmail) +
                "). Skipping email notification."
        );
        return { success: false, skipped: true, reason: "invalid_or_missing_email" };
    }

    try {
        if (getEmailProvider() === PROVIDER_GMAIL) {
            await ensureTransporterVerified();
        }

        // Defensive: never render an empty/undefined name in the email body.
        const safeName = escapeHtml(
            typeof candidateName === "string" && candidateName.trim()
                ? candidateName.trim()
                : "Candidate"
        );

        console.log("[EMAIL] Sending evaluation invitation");
        console.log(`[EMAIL] Recipient configured: ${isValidEmail(candidateEmail)}`);

        const calendlyLink = sanitizeHttpUrl(process.env.CALENDLY_LINK || "");
        const calendlyHref = escapeHtml(calendlyLink);

        const atsScore = atsEvaluation?.atsScore != null ? Number(atsEvaluation.atsScore) : null;
        const atsScoreSafe = Number.isFinite(atsScore) ? atsScore : null;
        const atsRecommendations = Array.isArray(atsEvaluation?.recommendations)
            ? atsEvaluation.recommendations.map((r) => escapeHtml(r)).filter(Boolean)
            : [];

        const { EMAIL_USER } = getEmailCredentials();
        const info = await deliverMail(
            {
                from: buildMailFrom(EMAIL_USER),
                to: candidateEmail,
                subject: "Interview Invitation",
                html: `
                <div style="font-family: Arial, sans-serif; padding:20px;">
                    <h2>Congratulations ${safeName}! 🎉</h2>
                    <p>
                        We are pleased to inform you that you have
                        successfully passed the resume evaluation stage.
                    </p>
                    <p>
                        Our recruitment team would like to invite you
                        for the next round of interviews.
                    </p>
                    ${atsScoreSafe !== null ? `<p><strong>ATS Compatibility Score:</strong> ${atsScoreSafe}/100</p>` : ""}
                    ${atsRecommendations.length > 0 ? `<p><strong>Key Recommendations:</strong></p><ul>${atsRecommendations.slice(0, 3).map((r) => `<li>${r}</li>`).join("")}</ul>` : ""}
                    ${
                        calendlyLink
                            ? `<p>Please schedule your interview using the link below:</p>
                    <p>
                        <a
                            href="${calendlyHref}"
                            style="
                                background:#2563eb;
                                color:white;
                                padding:12px 20px;
                                text-decoration:none;
                                border-radius:6px;
                            "
                        >
                            Schedule Interview
                        </a>
                    </p>`
                            : ""
                    }
                    <br>
                    <p>
                        Best Regards,<br>
                        Recruitment Team
                    </p>
                </div>
            `,
            },
            "Interview Invite"
        );

        console.log("[EMAIL] Provider accepted evaluation invitation");
        console.log(`[EMAIL] Provider messageId=${info.messageId || "none"}`);
        return { success: true, messageId: info.messageId, response: info.response };
    } catch (error) {
        console.error("[EMAIL] Provider rejected evaluation invitation");
        console.error(`[EMAIL] Provider error=${sanitizeEmailError(error)}`);
        throw error;
    }
}

/**
 * Sends a scheduled interview invitation with date, time, duration, and meeting link.
 */
async function sendScheduledInterviewInvite(interview) {
    const overallStarted = performance.now();
    const candidateEmail = interview?.candidateEmail;
    const interviewId = interview?.id || "unknown";
    const provider = getEmailProvider();

    console.log("[EMAIL] Preparing candidate interview email");
    console.log(`[EMAIL] Provider: ${provider}`);
    console.log(`[EMAIL] Sending candidate invitation`);
    console.log(`[EMAIL] Interview ID: ${interviewId}`);
    console.log(`[EMAIL] Recipient configured: ${isValidEmail(candidateEmail)}`);

    if (!isValidEmail(candidateEmail)) {
        console.error("[EMAIL] Candidate invitation failed: candidate email is missing or invalid");
        return {
            success: false,
            sent: false,
            skipped: true,
            reason: "invalid_or_missing_email",
            error: "Candidate email is missing or invalid",
        };
    }

    const configError = getEmailConfigError();
    if (configError) {
        console.error(`[EMAIL] Candidate invitation failed: ${configError}`);
        return { success: false, sent: false, error: configError };
    }

    try {
        let verifyMs = 0;
        if (provider === PROVIDER_GMAIL) {
            const verifyStarted = performance.now();
            const verified = await ensureTransporterVerified();
            verifyMs = performance.now() - verifyStarted;
            if (!verified) {
                console.warn(
                    "[EMAIL] Proceeding with send despite verify() failure — delivery may still succeed"
                );
            }
        }

        const safeName = escapeHtml(
            typeof interview.candidateName === "string" && interview.candidateName.trim()
                ? interview.candidateName.trim()
                : "Candidate"
        );
        const date = escapeHtml(interview.date || interview.interviewDate || "TBD");
        const time = escapeHtml(interview.time || interview.interviewTime || "TBD");
        const timezone = escapeHtml(interview.timezone || "UTC");
        const duration = Number(interview.durationMinutes) || 25;
        const jobRole = escapeHtml(resolveJobRole(interview));
        const interviewer = escapeHtml(
            typeof interview.interviewer === "string" && interview.interviewer.trim()
                ? interview.interviewer.trim()
                : ""
        );
        const recruiterContact = escapeHtml(resolveRecruiterContact());
        const meetingLink = resolveCandidateInterviewUrl(interview);
        const meetingHref = escapeHtml(meetingLink);
        const urlGenerated = Boolean(meetingLink && meetingLink.includes("/candidate-interview/"));
        console.log(`[EMAIL] Candidate URL generated: ${urlGenerated}`);

        if (!urlGenerated) {
            const error =
                "FRONTEND_URL is missing or invalid; candidate interview URL could not be generated";
            console.error(`[EMAIL] Candidate invitation failed: ${error}`);
            return { success: false, sent: false, error };
        }

        if (isProductionRuntime() && !isUsablePublicFrontendUrl(meetingLink)) {
            const error =
                "FRONTEND_URL must be a public production URL for candidate invitation emails";
            console.error(`[EMAIL] Candidate invitation failed: ${error}`);
            return { success: false, sent: false, error };
        }

        const { EMAIL_USER } = getEmailCredentials();
        const sendStarted = performance.now();
        const info = await deliverMail(
            {
                from: buildMailFrom(EMAIL_USER),
                to: candidateEmail,
                subject: "Interview Scheduled — Invitation",
                html: `
                <div style="font-family: Arial, sans-serif; padding:20px; max-width:560px;">
                    <h2 style="color:#0f172a;">Interview Invitation</h2>
                    <p>Hello ${safeName},</p>
                    <p>
                        Your interview has been scheduled. Please find the details below:
                    </p>
                    <table style="border-collapse:collapse; width:100%; margin:16px 0;">
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Candidate</td>
                            <td style="padding:8px 0; font-weight:600;">${safeName}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Job Role</td>
                            <td style="padding:8px 0; font-weight:600;">${jobRole}</td>
                        </tr>
                        ${
                            interviewer
                                ? `<tr>
                            <td style="padding:8px 0; color:#64748b;">Interviewer</td>
                            <td style="padding:8px 0; font-weight:600;">${interviewer}</td>
                        </tr>`
                                : ""
                        }
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Date</td>
                            <td style="padding:8px 0; font-weight:600;">${date}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Time</td>
                            <td style="padding:8px 0; font-weight:600;">${time} (${timezone})</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Duration</td>
                            <td style="padding:8px 0; font-weight:600;">${duration} minutes</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Recruiter Contact</td>
                            <td style="padding:8px 0; font-weight:600;">${recruiterContact}</td>
                        </tr>
                    </table>
                    ${
                        meetingLink
                            ? `
                    <p>Join your interview using the link below:</p>
                    <p>
                        <a
                            href="${meetingHref}"
                            style="
                                background:#2563eb;
                                color:white;
                                padding:12px 20px;
                                text-decoration:none;
                                border-radius:6px;
                                display:inline-block;
                            "
                        >
                            Join Interview
                        </a>
                    </p>
                    <p style="color:#64748b; font-size:13px; word-break:break-all;">${meetingHref}</p>
                    `
                            : ""
                    }
                    <br>
                    <p>
                        Best Regards,<br>
                        Recruitment Team
                    </p>
                </div>
            `,
            },
            "Scheduled Invite"
        );
        const sendMs = performance.now() - sendStarted;

        if (!info?.messageId) {
            console.error("[EMAIL] Provider rejected candidate invitation");
            console.error("[EMAIL] Provider error=missing provider message id");
            return { success: false, sent: false, error: "Provider did not return a message id" };
        }

        console.log("[EMAIL] Provider accepted candidate invitation");
        console.log(`[EMAIL] Provider messageId=${info.messageId}`);
        console.log(
            `[EMAIL] Scheduled Invite timing: verify=${verifyMs.toFixed(1)}ms ` +
                `send=${sendMs.toFixed(1)}ms total=${(performance.now() - overallStarted).toFixed(1)}ms`
        );
        return {
            success: true,
            sent: true,
            messageId: info.messageId,
            response: info.response,
        };
    } catch (error) {
        const safeError = sanitizeEmailError(error);
        console.error("[EMAIL] Provider rejected candidate invitation");
        console.error(`[EMAIL] Provider error=${safeError}`);
        return { success: false, sent: false, error: safeError };
    }
}

/**
 * Sends a reminder email before a scheduled interview.
 * @param {object} interview
 * @param {"24h"|"1h"|"30m"|"10m"} reminderType
 */
async function sendInterviewReminder(interview, reminderType) {
    const candidateEmail = interview?.candidateEmail;
    if (!isValidEmail(candidateEmail)) {
        return { success: false, skipped: true, reason: "invalid_or_missing_email" };
    }

    const label = reminderLabel(reminderType);
    const candidateName =
        typeof interview.candidateName === "string" && interview.candidateName.trim()
            ? interview.candidateName.trim()
            : "Candidate";
    const interviewDate = interview.date || interview.interviewDate || "TBD";
    const interviewTime = interview.time || interview.interviewTime || "TBD";
    const timezone = interview.timezone || "UTC";

    console.log(`[EMAIL] Provider: ${getEmailProvider()}`);
    console.log(`[EMAIL] Sending ${reminderType} reminder`);
    console.log(`[EMAIL] Recipient configured: ${isValidEmail(candidateEmail)}`);

    try {
        if (getEmailProvider() === PROVIDER_GMAIL) {
            const verified = await ensureTransporterVerified();
            if (!verified) {
                console.warn(
                    "[EMAIL] Proceeding with send despite verify() failure — delivery may still succeed"
                );
            }
        }

        const safeName = escapeHtml(candidateName);
        const date = escapeHtml(interviewDate);
        const time = escapeHtml(interviewTime);
        const tz = escapeHtml(timezone);
        const duration = Number(interview.durationMinutes) || 25;
        const jobRole = escapeHtml(resolveJobRole(interview));
        const recruiterContact = escapeHtml(resolveRecruiterContact());
        const meetingLink = resolveCandidateInterviewUrl(interview);
        const meetingHref = escapeHtml(meetingLink);
        const labelSafe = escapeHtml(label);

        const { EMAIL_USER } = getEmailCredentials();
        const info = await deliverMail(
            {
                from: buildMailFrom(EMAIL_USER),
                to: candidateEmail,
                subject: `Reminder: Your Interview starts in ${label}`,
                html: `
                <div style="font-family: Arial, sans-serif; padding:20px; max-width:560px;">
                    <h2 style="color:#0f172a;">Interview Reminder</h2>
                    <p>Hello ${safeName},</p>
                    <p>
                        This is a friendly reminder that your interview starts in
                        <strong>${labelSafe}</strong>.
                    </p>
                    <table style="border-collapse:collapse; width:100%; margin:16px 0;">
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Candidate Name</td>
                            <td style="padding:8px 0; font-weight:600;">${safeName}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Job Role</td>
                            <td style="padding:8px 0; font-weight:600;">${jobRole}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Interview Date</td>
                            <td style="padding:8px 0; font-weight:600;">${date}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Interview Time</td>
                            <td style="padding:8px 0; font-weight:600;">${time} (${tz})</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Duration</td>
                            <td style="padding:8px 0; font-weight:600;">${duration} minutes</td>
                        </tr>
                        <tr>
                            <td style="padding:8px 0; color:#64748b;">Recruiter Contact</td>
                            <td style="padding:8px 0; font-weight:600;">${recruiterContact}</td>
                        </tr>
                    </table>
                    ${
                        meetingLink
                            ? `
                    <p>Meeting Link:</p>
                    <p>
                        <a
                            href="${meetingHref}"
                            style="
                                background:#2563eb;
                                color:white;
                                padding:12px 20px;
                                text-decoration:none;
                                border-radius:6px;
                                display:inline-block;
                            "
                        >
                            Join Interview
                        </a>
                    </p>
                    <p style="color:#64748b; font-size:13px; word-break:break-all;">${meetingHref}</p>
                    `
                            : ""
                    }
                    <br>
                    <p>
                        Best Regards,<br>
                        Recruitment Team
                    </p>
                </div>
            `,
            },
            `Reminder ${reminderType}`
        );

        if (!info?.messageId) {
            throw new EmailSendError("Provider did not return a message id", { retryable: true });
        }

        console.log(`[EMAIL] Provider accepted reminder`);
        console.log(`[EMAIL] Provider messageId=${info.messageId}`);
        return {
            success: true,
            messageId: info.messageId,
            response: info.response,
        };
    } catch (error) {
        const safeError = sanitizeEmailError(error);
        console.error(`[EMAIL] Provider rejected reminder`);
        console.error(`[EMAIL] Provider error=${safeError}`);
        throw new EmailSendError(safeError, {
            retryable: isRetryableEmailError(error),
            statusCode: error.statusCode || null,
        });
    }
}

function __setEmailTransportForTests(fn) {
    testTransport = typeof fn === "function" ? fn : null;
}

function __resetEmailServiceForTests() {
    transporter = null;
    transporterVerified = false;
    smtpTransporterCreated = false;
    resendClient = null;
    testTransport = null;
}

function __didCreateSmtpTransporter() {
    return smtpTransporterCreated;
}

module.exports = {
    sendInterviewInvite,
    sendScheduledInterviewInvite,
    sendInterviewReminder,
    isValidEmail,
    isEmailConfigured,
    warnIfEmailEnvMissing,
    ensureTransporterVerified,
    getSmtpConfig,
    getEmailProvider,
    getPublicEmailStatus,
    resolveCandidateInterviewUrl,
    sanitizeEmailError,
    isRetryableEmailError,
    EmailSendError,
    __setEmailTransportForTests,
    __resetEmailServiceForTests,
    __didCreateSmtpTransporter,
};
