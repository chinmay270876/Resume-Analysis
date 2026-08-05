const crypto = require("crypto");

/**
 * Optional API-key gate. When API_KEY is unset, all requests pass through
 * (backwards-compatible for local/dev). When set, require matching
 * X-API-Key, Authorization: Bearer <key>, or (GET only) ?api_key= for
 * browser download links that cannot send custom headers.
 */
function timingSafeEqualString(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) {
        // Compare against itself to keep runtime roughly constant on length mismatch
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function apiKeyAuth(req, res, next) {
    const expected = process.env.API_KEY;
    if (!expected) {
        return next();
    }

    const headerKey = req.get("x-api-key");
    const auth = req.get("authorization") || "";
    const bearer = auth.toLowerCase().startsWith("bearer ")
        ? auth.slice(7).trim()
        : "";
    // Query param only for safe read/download methods (anchor downloads)
    const queryKey =
        req.method === "GET" || req.method === "HEAD"
            ? (typeof req.query?.api_key === "string" ? req.query.api_key : "")
            : "";
    const provided = headerKey || bearer || queryKey;

    if (!provided || !timingSafeEqualString(provided, expected)) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized",
        });
    }

    return next();
}

module.exports = { apiKeyAuth };
