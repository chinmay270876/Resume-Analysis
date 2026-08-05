/**
 * Optional API-key gate. When API_KEY is unset, all requests pass through
 * (backwards-compatible for local/dev). When set, require matching
 * X-API-Key or Authorization: Bearer <key> on protected routes.
 */
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
    const provided = headerKey || bearer;

    if (!provided || provided !== expected) {
        return res.status(401).json({
            success: false,
            error: "Unauthorized",
        });
    }

    return next();
}

module.exports = { apiKeyAuth };
