const crypto = require("crypto");

function createHttpError(message, status = 500, stage = "hms") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

/**
 * Resolve 100ms credentials. Supports literal `100MS_*` keys (as in .env.example)
 * and `HMS_*` aliases for shells that reject digit-prefixed names.
 */
function requireHmsConfig() {
    const accessKey =
        process.env["100MS_ACCESS_KEY"] || process.env.HMS_ACCESS_KEY || "";
    const secret = process.env["100MS_SECRET"] || process.env.HMS_SECRET || "";
    const roomId = process.env["100MS_ROOM_ID"] || process.env.HMS_ROOM_ID || "";

    if (!accessKey || !secret || !roomId) {
        throw createHttpError(
            "100ms is not configured. Set 100MS_ACCESS_KEY, 100MS_SECRET, and 100MS_ROOM_ID.",
            503
        );
    }

    return { accessKey, secret, roomId };
}

function base64url(value) {
    return Buffer.from(value)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

/**
 * Fallback HS256 JWT matching 100ms auth-token claims.
 */
function signAuthTokenJwt({ accessKey, secret, roomId, userId, role, validForSeconds = 86400 }) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT" };
    const payload = {
        access_key: accessKey,
        type: "app",
        version: 2,
        room_id: roomId,
        user_id: String(userId),
        role: role || "guest",
        iat: now,
        nbf: now,
        exp: now + validForSeconds,
        jti: crypto.randomUUID(),
    };

    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const data = `${encodedHeader}.${encodedPayload}`;
    const signature = crypto
        .createHmac("sha256", secret)
        .update(data)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

    return `${data}.${signature}`;
}

async function generateAuthToken({ userId, role = "guest", userName }) {
    const { accessKey, secret, roomId } = requireHmsConfig();
    const safeUserId = String(userId || userName || crypto.randomUUID()).slice(0, 64);

    try {
        const HMS = require("@100mslive/server-sdk");
        const hms = new HMS.SDK(accessKey, secret);
        const result = await hms.auth.getAuthToken({
            roomId,
            role,
            userId: safeUserId,
            validForSeconds: 24 * 60 * 60,
        });
        const token =
            typeof result === "string"
                ? result
                : result?.token || result?.authToken || null;
        if (!token) {
            throw new Error("100ms SDK returned an empty token");
        }
        return { token, roomId, userId: safeUserId, role };
    } catch (sdkErr) {
        console.warn(
            "[HMS] server-sdk token generation failed, using JWT fallback:",
            sdkErr.message
        );
        const token = signAuthTokenJwt({
            accessKey,
            secret,
            roomId,
            userId: safeUserId,
            role,
            validForSeconds: 24 * 60 * 60,
        });
        return { token, roomId, userId: safeUserId, role };
    }
}

function getConfiguredRoomId() {
    return requireHmsConfig().roomId;
}

module.exports = {
    generateAuthToken,
    getConfiguredRoomId,
    requireHmsConfig,
};
