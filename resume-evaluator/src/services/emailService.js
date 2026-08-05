const nodemailer = require("nodemailer");
const { escapeHtml, sanitizeHttpUrl } = require("../utils/htmlEscape");

// RFC-5322-lite: good enough to reject obvious garbage like "Not Provided",
// "N/A", "john@" or "plainstring" while accepting real addresses.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function getTransporter() {
    if (!transporter) {
        const EMAIL_USER = process.env.EMAIL_USER;
        const EMAIL_PASS = process.env.EMAIL_PASSWORD;

        if (!EMAIL_USER || !EMAIL_PASS) {
            throw new Error("Email credentials (EMAIL_USER, EMAIL_PASSWORD) are not configured in .env");
        }

        transporter = nodemailer.createTransport({
            host: "smtp.gmail.com",
            port: 587,
            secure: false,
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
    if (transporterVerified) return;
    try {
        const t = getTransporter();
        await t.verify();
        transporterVerified = true;
    } catch (err) {
        console.warn("⚠️ SMTP Transporter verification warning:", err.message);
    }
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
            (typeof candidateName === "string" && candidateName.trim())
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

        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
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
                    ${atsRecommendations.length > 0 ? `<p><strong>Key Recommendations:</strong></p><ul>${atsRecommendations.slice(0, 3).map(r => `<li>${r}</li>`).join("")}</ul>` : ""}
                    ${calendlyLink ? `<p>Please schedule your interview using the link below:</p>
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
                    </p>` : ""}
                    <br>
                    <p>
                        Best Regards,<br>
                        Recruitment Team
                    </p>
                </div>
            `,
        });

        console.log(`✅ Interview invitation sent to ${candidateEmail}. MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error("❌ Email Sending Error:", error.message);
        throw error;
    }
}

/**
 * Sends a scheduled interview invitation with date, time, duration, and meeting link.
 * Reuses the existing Nodemailer transporter / credential configuration.
 */
async function sendScheduledInterviewInvite(interview) {
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
        await ensureTransporterVerified();

        const safeName = escapeHtml(
            typeof interview.candidateName === "string" && interview.candidateName.trim()
                ? interview.candidateName.trim()
                : "Candidate"
        );
        const date = escapeHtml(interview.date || "TBD");
        const time = escapeHtml(interview.time || "TBD");
        const timezone = escapeHtml(interview.timezone || "UTC");
        const duration = Number(interview.durationMinutes) || 25;
        const meetingLink = sanitizeHttpUrl(
            interview.meetingLink || process.env.CALENDLY_LINK || ""
        );
        const meetingHref = escapeHtml(meetingLink);

        console.log(`📧 Sending scheduled interview invite to ${candidateEmail}`);

        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
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
                    </table>
                    ${meetingLink ? `
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
                    ` : ""}
                    <br>
                    <p>
                        Best Regards,<br>
                        Recruitment Team
                    </p>
                </div>
            `,
        });

        console.log(`✅ Scheduled interview invitation sent to ${candidateEmail}. MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error("❌ Scheduled Interview Email Error:", error.message);
        throw error;
    }
}

/**
 * Sends a reminder email before a scheduled interview.
 * @param {object} interview
 * @param {"24h"|"1h"|"10m"} reminderType
 */
async function sendInterviewReminder(interview, reminderType) {
    const candidateEmail = interview?.candidateEmail;
    if (!isValidEmail(candidateEmail)) {
        return { success: false, skipped: true, reason: "invalid_or_missing_email" };
    }

    const labels = {
        "24h": "24 hours",
        "1h": "1 hour",
        "10m": "10 minutes",
    };
    const label = labels[reminderType] || "soon";

    try {
        await ensureTransporterVerified();

        const safeName = escapeHtml(
            typeof interview.candidateName === "string" && interview.candidateName.trim()
                ? interview.candidateName.trim()
                : "Candidate"
        );
        const date = escapeHtml(interview.date || "TBD");
        const time = escapeHtml(interview.time || "TBD");
        const timezone = escapeHtml(interview.timezone || "UTC");
        const duration = Number(interview.durationMinutes) || 25;
        const meetingLink = sanitizeHttpUrl(interview.meetingLink || "");
        const meetingHref = escapeHtml(meetingLink);
        const labelSafe = escapeHtml(label);

        console.log(`📧 Sending ${reminderType} reminder to ${candidateEmail}`);

        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: candidateEmail,
            subject: `Interview Reminder — ${label} remaining`,
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
                    </table>
                    ${meetingLink ? `
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
                    ` : ""}
                    <br>
                    <p>
                        Best Regards,<br>
                        Recruitment Team
                    </p>
                </div>
            `,
        });

        console.log(`✅ ${reminderType} reminder sent to ${candidateEmail}. MessageId: ${info.messageId}`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error(`❌ Reminder Email Error (${reminderType}):`, error.message);
        throw error;
    }
}

module.exports = {
    sendInterviewInvite,
    sendScheduledInterviewInvite,
    sendInterviewReminder,
    isValidEmail,
};
