const nodemailer = require("nodemailer");

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

async function sendInterviewInvite(candidateName, candidateEmail) {
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
        const safeName = (typeof candidateName === "string" && candidateName.trim())
            ? candidateName.trim()
            : "Candidate";

        console.log(`📧 Sending interview invite to ${candidateEmail}`);

        const calendlyLink = process.env.CALENDLY_LINK || "";

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
                    ${calendlyLink ? `<p>Please schedule your interview using the link below:</p>
                    <p>
                        <a
                            href="${calendlyLink}"
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

module.exports = {
    sendInterviewInvite,
    isValidEmail,
};
