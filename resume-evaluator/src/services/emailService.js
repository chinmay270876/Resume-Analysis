const { performance } = require("perf_hooks");
const nodemailer = require("nodemailer");
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

function getEmailCredentials() {
    const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
    // Gmail app passwords are often pasted with spaces — strip them for SMTP auth.
    const EMAIL_PASS = String(process.env.EMAIL_PASSWORD || "").replace(/\s+/g, "");
    return { EMAIL_USER, EMAIL_PASS };
}

function isEmailConfigured() {
    const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();
    return Boolean(EMAIL_USER && EMAIL_PASS);
}

function sanitizeEmailError(error) {
    const raw = error && typeof error === "object" ? error.message : String(error || "Email send failed");
    return String(raw)
        .replace(/\/\/([^/@\s]+):([^@/\s]+)@/g, "//$1:<redacted>@")
        .replace(
            /\b(EMAIL_PASSWORD|SMTP_PASS(?:WORD)?|SMTP_PASSWORD|AUTH(?:ENTICATION)?[_-]?TOKEN|API[_-]?KEY|BEARER)\b\s*[=:]\s*\S+/gi,
            "$1=<redacted>"
        )
        .replace(/pass(?:word)?[=:]\s*[^,\s]+/gi, "password=<redacted>")
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

/**
 * Startup validation — logs warnings for missing email/SMTP env vars.
 * Does not throw; scheduling must keep working without email.
 */
function warnIfEmailEnvMissing() {
    const { host, port } = getSmtpConfig();
    const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();
    const hostConfigured = Boolean(String(process.env.SMTP_HOST || host || "").trim());

    console.log(`[EMAIL] SMTP configured: ${isEmailConfigured()}`);
    console.log(`[EMAIL] SMTP host configured: ${hostConfigured}`);
    console.log(`[EMAIL] SMTP user configured: ${Boolean(EMAIL_USER)}`);
    console.log(`[EMAIL] SMTP password configured: ${Boolean(EMAIL_PASS)}`);
    console.log(`[EMAIL] SMTP port configured: ${Boolean(port)}`);
    console.log(`[EMAIL] FRONTEND_URL configured: ${Boolean(String(process.env.FRONTEND_URL || "").trim())}`);

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
    if (!transporter) {
        const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();

        if (!EMAIL_USER || !EMAIL_PASS) {
            throw new Error(
                "Email credentials (EMAIL_USER, EMAIL_PASSWORD) are not configured"
            );
        }

        const { host, port, secure } = getSmtpConfig();

        console.log(
            `[EMAIL] Creating SMTP transporter hostConfigured=true portConfigured=true ` +
                `secure=${secure} userConfigured=true passwordConfigured=true`
        );

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

/**
 * Send mail with up to 3 attempts and exponential backoff (1s, 2s, 4s).
 */
function assertSmtpAccepted(info, label = "Email") {
    const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
    const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
    if (rejected.length > 0 && accepted.length === 0) {
        throw new Error(`${label} was rejected by SMTP`);
    }
    if (accepted.length === 0 && !info?.messageId) {
        throw new Error(`${label} was not accepted by SMTP`);
    }
    return info;
}

async function sendMailWithRetry(mailOptions, label = "Email") {
    const t = getTransporter();
    let lastError;

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
            console.log(`[EMAIL] ${label} attempt ${attempt}/${MAX_SEND_ATTEMPTS}`);
            const info = assertSmtpAccepted(await t.sendMail(mailOptions), label);
            console.log(`[EMAIL] ${label} accepted by SMTP`, {
                messageId: info.messageId || null,
                acceptedCount: Array.isArray(info.accepted) ? info.accepted.length : 0,
                rejectedCount: Array.isArray(info.rejected) ? info.rejected.length : 0,
            });
            return info;
        } catch (err) {
            lastError = err;
            console.error(
                `[EMAIL] ${label} attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${sanitizeEmailError(err)}`
            );
            if (attempt < MAX_SEND_ATTEMPTS) {
                const delayMs = Math.pow(2, attempt - 1) * 1000;
                console.log(`[EMAIL] Retrying ${label} in ${delayMs}ms...`);
                await sleep(delayMs);
            }
        }
    }

    throw lastError;
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
        await ensureTransporterVerified();

        // Defensive: never render an empty/undefined name in the email body.
        const safeName = escapeHtml(
            typeof candidateName === "string" && candidateName.trim()
                ? candidateName.trim()
                : "Candidate"
        );

        console.log(`📧 Sending interview invite to ${candidateEmail}`);

        const calendlyLink = sanitizeHttpUrl(process.env.CALENDLY_LINK || "");
        const calendlyHref = escapeHtml(calendlyLink);

        const atsScore = atsEvaluation?.atsScore != null ? Number(atsEvaluation.atsScore) : null;
        const atsScoreSafe = Number.isFinite(atsScore) ? atsScore : null;
        const atsRecommendations = Array.isArray(atsEvaluation?.recommendations)
            ? atsEvaluation.recommendations.map((r) => escapeHtml(r)).filter(Boolean)
            : [];

        const { EMAIL_USER } = getEmailCredentials();
        const info = await sendMailWithRetry(
            {
                from: EMAIL_USER,
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

        console.log(
            `✅ Interview invitation sent to ${candidateEmail}. MessageId: ${info.messageId}`
        );
        return { success: true, messageId: info.messageId, response: info.response };
    } catch (error) {
        console.error("❌ Email Sending Error:", error.message);
        if (error.stack) console.error(error.stack);
        throw error;
    }
}

/**
 * Sends a scheduled interview invitation with date, time, duration, and meeting link.
 * Reuses the existing Nodemailer transporter / credential configuration.
 */
async function sendScheduledInterviewInvite(interview) {
    const overallStarted = performance.now();
    const candidateEmail = interview?.candidateEmail;
    const interviewId = interview?.id || "unknown";

    console.log("[EMAIL] Preparing candidate interview email");
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

    if (!isEmailConfigured()) {
        const error = "EMAIL_USER and EMAIL_PASSWORD are not configured";
        console.error(`[EMAIL] Candidate invitation failed: ${error}`);
        return { success: false, sent: false, error };
    }

    try {
        const verifyStarted = performance.now();
        const verified = await ensureTransporterVerified();
        const verifyMs = performance.now() - verifyStarted;
        if (!verified) {
            console.warn(
                "[EMAIL] Proceeding with send despite verify() failure — delivery may still succeed"
            );
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

        if (
            (process.env.NODE_ENV === "production" || process.env.RENDER) &&
            !isUsablePublicFrontendUrl(meetingLink)
        ) {
            const error =
                "FRONTEND_URL must be a public production URL for candidate invitation emails";
            console.error(`[EMAIL] Candidate invitation failed: ${error}`);
            return { success: false, sent: false, error };
        }

        const { EMAIL_USER } = getEmailCredentials();
        const sendStarted = performance.now();
        const info = await sendMailWithRetry(
            {
                from: EMAIL_USER,
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

        console.log("[EMAIL] Candidate invitation accepted by SMTP");
        console.log(`[EMAIL] messageId=${info.messageId || "none"}`);
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
        console.error("[EMAIL] Candidate invitation failed");
        console.error(`[EMAIL] error=${safeError}`);
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
    const reminderTimeIso =
        interview.reminderTimestamps?.[reminderType] ||
        interview.reminderTimestamp ||
        null;

    console.log("[Email] Reminder attempt details:", {
        candidateName,
        email: candidateEmail,
        interviewDate,
        interviewTime: `${interviewTime} (${timezone})`,
        scheduledAt: interview.scheduledAt || interview.scheduledTimestamp || null,
        reminderTime: reminderTimeIso,
        reminderType,
    });

    try {
        const verified = await ensureTransporterVerified();
        if (!verified) {
            console.warn(
                "[Email] Proceeding with send despite verify() failure — delivery may still succeed"
            );
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
        const info = await sendMailWithRetry(
            {
                from: EMAIL_USER,
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

        console.log(
            `✅ Reminder sent successfully (${reminderType}) to ${candidateEmail}. MessageId: ${info.messageId}`
        );
        return {
            success: true,
            messageId: info.messageId,
            response: info.response,
        };
    } catch (error) {
        console.error(`❌ Reminder Email Error (${reminderType}):`, error.message);
        if (error.stack) console.error(error.stack);
        throw error;
    }
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
    resolveCandidateInterviewUrl,
    sanitizeEmailError,
};
