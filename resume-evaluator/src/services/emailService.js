const { performance } = require("perf_hooks");
const nodemailer = require("nodemailer");
const { escapeHtml, sanitizeHttpUrl } = require("../utils/htmlEscape");

// RFC-5322-lite: good enough to reject obvious garbage like "Not Provided",
// "N/A", "john@" or "plainstring" while accepting real addresses.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SMTP_HOST = "smtp.gmail.com";
const DEFAULT_SMTP_PORT = 587;
const MAX_SEND_ATTEMPTS = 3;

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
    const required = ["EMAIL_USER", "EMAIL_PASSWORD"];
    const optionalWithDefaults = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE"];
    const missingRequired = required.filter((key) => !String(process.env[key] || "").trim());
    const missingOptional = optionalWithDefaults.filter(
        (key) => process.env[key] == null || String(process.env[key]).trim() === ""
    );

    if (missingRequired.length > 0) {
        console.warn(
            `[Email] STARTUP WARNING: Missing required env vars: ${missingRequired.join(", ")}. ` +
                "Reminder and invitation emails will fail until configured."
        );
    }
    if (missingOptional.length > 0) {
        const defaults = getSmtpConfig();
        console.warn(
            `[Email] STARTUP WARNING: Missing optional SMTP env vars: ${missingOptional.join(", ")}. ` +
                `Using defaults host=${defaults.host} port=${defaults.port} secure=${defaults.secure}.`
        );
    }
}

function getTransporter() {
    if (!transporter) {
        const { EMAIL_USER, EMAIL_PASS } = getEmailCredentials();

        if (!EMAIL_USER || !EMAIL_PASS) {
            throw new Error(
                "Email credentials (EMAIL_USER, EMAIL_PASSWORD) are not configured in .env"
            );
        }

        const { host, port, secure } = getSmtpConfig();

        console.log(
            `[Email] Creating SMTP transporter host=${host} port=${port} secure=${secure} user=${EMAIL_USER}`
        );

        transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: {
                user: EMAIL_USER,
                pass: EMAIL_PASS,
            },
            family: 4,
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
        console.log("[Email] SMTP transporter.verify() succeeded");
        return true;
    } catch (err) {
        console.error("[Email] SMTP transporter.verify() FAILED:");
        console.error(`  message: ${err.message}`);
        if (err.code) console.error(`  code: ${err.code}`);
        if (err.response) console.error(`  response: ${err.response}`);
        if (err.stack) console.error(err.stack);
        return false;
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send mail with up to 3 attempts and exponential backoff (1s, 2s, 4s).
 */
async function sendMailWithRetry(mailOptions, label = "Email") {
    const t = getTransporter();
    let lastError;

    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
            console.log(`[Email] ${label} attempt ${attempt}/${MAX_SEND_ATTEMPTS}`);
            const info = await t.sendMail(mailOptions);
            console.log(`[Email] ${label} SMTP response:`, {
                messageId: info.messageId || null,
                response: info.response || null,
                accepted: info.accepted || [],
                rejected: info.rejected || [],
            });
            return info;
        } catch (err) {
            lastError = err;
            console.error(
                `[Email] ${label} attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${err.message}`
            );
            if (err.stack) {
                console.error(err.stack);
            }
            if (attempt < MAX_SEND_ATTEMPTS) {
                const delayMs = Math.pow(2, attempt - 1) * 1000;
                console.log(`[Email] Retrying ${label} in ${delayMs}ms...`);
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
    if (!isValidEmail(candidateEmail)) {
        console.warn(
            "Candidate email missing or invalid (" +
                JSON.stringify(candidateEmail) +
                "). Skipping scheduled interview invitation."
        );
        return { success: false, skipped: true, reason: "invalid_or_missing_email" };
    }

    try {
        const verifyStarted = performance.now();
        await ensureTransporterVerified();
        const verifyMs = performance.now() - verifyStarted;

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
        const recruiterContact = escapeHtml(resolveRecruiterContact());
        const meetingLink = sanitizeHttpUrl(
            interview.meetingLink || process.env.CALENDLY_LINK || ""
        );
        const meetingHref = escapeHtml(meetingLink);

        console.log(`📧 Sending scheduled interview invite to ${candidateEmail}`);

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
                            Interview Link
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

        console.log(
            `✅ Scheduled interview invitation sent to ${candidateEmail}. MessageId: ${info.messageId}`
        );
        console.log(
            `[Email] Scheduled Invite timing: verify=${verifyMs.toFixed(1)}ms ` +
                `send=${sendMs.toFixed(1)}ms total=${(performance.now() - overallStarted).toFixed(1)}ms`
        );
        return { success: true, messageId: info.messageId, response: info.response };
    } catch (error) {
        console.error(
            `❌ Scheduled Interview Email Error after ${(performance.now() - overallStarted).toFixed(1)}ms:`,
            error.message
        );
        if (error.stack) console.error(error.stack);
        throw error;
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
        const meetingLink = sanitizeHttpUrl(interview.meetingLink || "");
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
    warnIfEmailEnvMissing,
    ensureTransporterVerified,
    getSmtpConfig,
};
