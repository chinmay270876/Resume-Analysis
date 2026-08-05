/**
 * Escape text for safe interpolation into HTML email bodies.
 */
function escapeHtml(value) {
    if (value == null) {
        return "";
    }
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Allow only http(s) URLs for meeting / calendly links in emails and storage.
 * Returns the trimmed URL or "" if invalid. Optional host allowlist via
 * MEETING_LINK_ALLOWED_HOSTS (comma-separated).
 */
function sanitizeHttpUrl(value) {
    if (typeof value !== "string") {
        return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return "";
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "";
    }

    const allowlist = (process.env.MEETING_LINK_ALLOWED_HOSTS || "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);

    if (allowlist.length > 0 && !allowlist.includes(parsed.hostname.toLowerCase())) {
        return "";
    }

    return trimmed;
}

module.exports = { escapeHtml, sanitizeHttpUrl };
