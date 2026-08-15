const crypto = require("crypto");
const path = require("path");
const fsp = require("fs").promises;

const HMS_API_BASE = "https://api.100ms.live/v2";

const APP_ROLES = Object.freeze({
    STUDENT: "student",
    INTERVIEWER: "interviewer",
    ADMIN: "admin",
});

function createHttpError(message, status = 500, stage = "hms") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

function firstEnv(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }
    return "";
}

/**
 * Resolve 100ms credentials from the current env system.
 * Preferred: HMS_APP_ACCESS_KEY / HMS_APP_SECRET / HMS_TEMPLATE_ID
 * Aliases: HMS_ACCESS_KEY, 100MS_* (legacy)
 */
function getHmsConfig() {
    const accessKey = firstEnv(
        "HMS_APP_ACCESS_KEY",
        "HMS_ACCESS_KEY",
        "100MS_ACCESS_KEY"
    );
    const secret = firstEnv("HMS_APP_SECRET", "HMS_SECRET", "100MS_SECRET");
    const templateId = firstEnv("HMS_TEMPLATE_ID", "100MS_TEMPLATE_ID");
    const legacyRoomId = firstEnv("HMS_ROOM_ID", "100MS_ROOM_ID");
    const webhookSecret = firstEnv("HMS_WEBHOOK_SECRET", "100MS_WEBHOOK_SECRET");
    const region = firstEnv("HMS_REGION", "100MS_REGION") || "in";
    const roles = {
        [APP_ROLES.INTERVIEWER]: firstEnv("HMS_ROLE_INTERVIEWER", "100MS_ROLE_INTERVIEWER") || "interviewer",
        [APP_ROLES.STUDENT]: firstEnv("HMS_ROLE_STUDENT", "100MS_ROLE", "HMS_ROLE") || "student",
        [APP_ROLES.ADMIN]: firstEnv("HMS_ROLE_ADMIN", "100MS_ROLE_ADMIN") || "host",
    };

    return {
        accessKey,
        secret,
        templateId,
        legacyRoomId,
        webhookSecret,
        region,
        roles,
    };
}

function isHmsConfigured() {
    const { accessKey, secret, templateId, legacyRoomId } = getHmsConfig();
    return Boolean(accessKey && secret && (templateId || legacyRoomId));
}

function requireHmsConfig() {
    const config = getHmsConfig();
    if (!config.accessKey || !config.secret) {
        throw createHttpError(
            "100ms is not configured. Set HMS_APP_ACCESS_KEY and HMS_APP_SECRET.",
            503
        );
    }
    if (!config.templateId && !config.legacyRoomId) {
        throw createHttpError(
            "100ms is not configured. Set HMS_TEMPLATE_ID (preferred) or a legacy room id.",
            503
        );
    }
    return config;
}

function getHmsRoleForAppRole(appRole) {
    const config = getHmsConfig();
    const normalized = String(appRole || "").trim().toLowerCase();
    if (normalized === APP_ROLES.STUDENT || normalized === "candidate") {
        return config.roles[APP_ROLES.STUDENT];
    }
    if (normalized === APP_ROLES.INTERVIEWER || normalized === "recruiter") {
        return config.roles[APP_ROLES.INTERVIEWER];
    }
    if (normalized === APP_ROLES.ADMIN || normalized === "spectator" || normalized === "host") {
        return config.roles[APP_ROLES.ADMIN];
    }
    throw createHttpError("Invalid interview join role.", 400);
}

function resolveAppRoleFromJoinAs(joinAs) {
    const normalized = String(joinAs || APP_ROLES.INTERVIEWER).trim().toLowerCase();
    if (normalized === APP_ROLES.INTERVIEWER || normalized === "recruiter") {
        return APP_ROLES.INTERVIEWER;
    }
    if (
        normalized === APP_ROLES.ADMIN ||
        normalized === "spectator" ||
        normalized === "host"
    ) {
        return APP_ROLES.ADMIN;
    }
    throw createHttpError(
        "Recruiters may join as interviewer or spectator only.",
        403
    );
}

function resolveAppRoleFromHmsRole(hmsRole) {
    const config = getHmsConfig();
    const value = String(hmsRole || "").trim().toLowerCase();
    if (!value) return null;
    if (value === String(config.roles[APP_ROLES.STUDENT]).toLowerCase() || value === "student" || value === "guest") {
        return APP_ROLES.STUDENT;
    }
    if (value === String(config.roles[APP_ROLES.INTERVIEWER]).toLowerCase() || value === "interviewer") {
        return APP_ROLES.INTERVIEWER;
    }
    if (
        value === String(config.roles[APP_ROLES.ADMIN]).toLowerCase() ||
        value === "host" ||
        value === "admin" ||
        value === "spectator"
    ) {
        return APP_ROLES.ADMIN;
    }
    return null;
}

function base64url(value) {
    return Buffer.from(value)
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

function signJwt(secret, payload) {
    const header = { alg: "HS256", typ: "JWT" };
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

function generateManagementToken(validForSeconds = 24 * 60 * 60) {
    const { accessKey, secret } = requireHmsConfig();
    const now = Math.floor(Date.now() / 1000);
    return signJwt(secret, {
        access_key: accessKey,
        type: "management",
        version: 2,
        iat: now,
        nbf: now,
        exp: now + validForSeconds,
        jti: crypto.randomUUID(),
    });
}

function signAuthTokenJwt({
    accessKey,
    secret,
    roomId,
    userId,
    role,
    validForSeconds = 86400,
}) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt(secret, {
        access_key: accessKey,
        type: "app",
        version: 2,
        room_id: roomId,
        user_id: String(userId),
        role,
        iat: now,
        nbf: now,
        exp: now + validForSeconds,
        jti: crypto.randomUUID(),
    });
}

function publicWebhookUrl() {
    const base = firstEnv("RENDER_EXTERNAL_URL", "BACKEND_PUBLIC_URL", "API_PUBLIC_URL");
    if (!base) return null;
    if (/localhost|127\.0\.0\.1/i.test(base)) return null;
    return `${base.replace(/\/$/, "")}/api/100ms/webhook`;
}

async function hmsApi(pathname, { method = "GET", body } = {}) {
    const token = generateManagementToken();
    const response = await fetch(`${HMS_API_BASE}${pathname}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        } catch {
            data = { raw: text };
        }
    }

    if (!response.ok) {
        const message =
            data?.message ||
            data?.error ||
            `100ms API request failed (${response.status})`;
        const err = createHttpError(message, response.status >= 500 ? 502 : 502, "hms-api");
        err.hmsStatus = response.status;
        throw err;
    }

    return data;
}

function roomNameForInterview(interviewId) {
    const safe = String(interviewId || "")
        .replace(/[^a-zA-Z0-9._:-]/g, "-")
        .slice(0, 80);
    return `interview-${safe || crypto.randomUUID()}`;
}

async function createInterviewRoom({ interviewId, durationMinutes } = {}) {
    const config = requireHmsConfig();
    const name = roomNameForInterview(interviewId);
    const maxDurationSeconds = Math.max(
        120,
        Math.min(43200, Math.round((Number(durationMinutes) || 30) * 60) + 600)
    );

    const payload = {
        name,
        description: `Scheduled interview ${interviewId}`,
        region: config.region || "in",
        max_duration_seconds: maxDurationSeconds,
    };
    if (config.templateId) {
        payload.template_id = config.templateId;
    }

    const webhookUrl = publicWebhookUrl();
    if (webhookUrl && config.webhookSecret) {
        payload.webhook = {
            url: webhookUrl,
            headers: {
                "x-100ms-webhook-secret": config.webhookSecret,
            },
        };
    }

    try {
        const HMS = require("@100mslive/server-sdk");
        const hms = new HMS.SDK(config.accessKey, config.secret);
        if (hms.rooms && typeof hms.rooms.create === "function") {
            const room = await hms.rooms.create(payload);
            if (room?.id) {
                console.log("[100MS] Interview room/session created", {
                    interviewId,
                    roomId: room.id,
                });
                return {
                    roomId: room.id,
                    roomName: room.name || name,
                    templateId: room.template_id || config.templateId || null,
                };
            }
        }
    } catch (sdkErr) {
        console.warn(
            "[100MS] SDK room create failed, using REST:",
            sdkErr.message
        );
    }

    const room = await hmsApi("/rooms", { method: "POST", body: payload });
    if (!room?.id) {
        throw createHttpError("100ms did not return a room id.", 502);
    }
    console.log("[100MS] Interview room/session created", {
        interviewId,
        roomId: room.id,
    });
    return {
        roomId: room.id,
        roomName: room.name || name,
        templateId: room.template_id || config.templateId || null,
    };
}

async function generateAuthToken({
    userId,
    role,
    userName,
    roomId,
    validForSeconds = 24 * 60 * 60,
}) {
    const config = requireHmsConfig();
    const resolvedRoomId = roomId || config.legacyRoomId;
    if (!resolvedRoomId) {
        throw createHttpError(
            "No 100ms room is available for this interview yet.",
            503
        );
    }
    if (!role) {
        throw createHttpError("A 100ms role is required to generate a token.", 400);
    }

    const safeUserId = String(userId || userName || crypto.randomUUID()).slice(0, 64);

    try {
        const HMS = require("@100mslive/server-sdk");
        const hms = new HMS.SDK(config.accessKey, config.secret);
        const result = await hms.auth.getAuthToken({
            roomId: resolvedRoomId,
            role,
            userId: safeUserId,
            validForSeconds,
        });
        const token =
            typeof result === "string"
                ? result
                : result?.token || result?.authToken || null;
        if (!token) {
            throw new Error("100ms SDK returned an empty token");
        }
        console.log("[100MS] Token generated", {
            roomId: resolvedRoomId,
            role,
            userId: safeUserId,
        });
        return { token, roomId: resolvedRoomId, userId: safeUserId, role };
    } catch (sdkErr) {
        console.warn(
            "[100MS] server-sdk token generation failed, using JWT fallback:",
            sdkErr.message
        );
        const token = signAuthTokenJwt({
            accessKey: config.accessKey,
            secret: config.secret,
            roomId: resolvedRoomId,
            userId: safeUserId,
            role,
            validForSeconds,
        });
        console.log("[100MS] Token generated", {
            roomId: resolvedRoomId,
            role,
            userId: safeUserId,
            fallback: true,
        });
        return { token, roomId: resolvedRoomId, userId: safeUserId, role };
    }
}

function normalizeSignature(value) {
    if (!value || typeof value !== "string") return "";
    return value.trim().replace(/^sha256=/i, "").trim();
}

function timingSafeEqualString(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify 100ms webhook authenticity.
 * Supports HMAC (x-100ms-signature) and a shared secret header.
 */
function verifyWebhookSignature({ rawBody, headers = {}, secret } = {}) {
    const webhookSecret = secret || getHmsConfig().webhookSecret;
    if (!webhookSecret) {
        return { ok: false, reason: "missing_webhook_secret" };
    }

    const headerMap = {};
    for (const [key, value] of Object.entries(headers || {})) {
        headerMap[String(key).toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }

    const providedSecret = [
        headerMap["x-100ms-webhook-secret"],
        headerMap["x-webhook-secret"],
        headerMap["x-100ms-secret"],
    ].find((value) => typeof value === "string" && value);

    if (providedSecret && timingSafeEqualString(providedSecret, webhookSecret)) {
        return { ok: true, method: "shared-secret" };
    }

    const signature = normalizeSignature(
        headerMap["x-100ms-signature"] || headerMap["x-hms-signature"] || ""
    );
    if (!signature) {
        return { ok: false, reason: "missing_signature" };
    }

    const payload = Buffer.isBuffer(rawBody)
        ? rawBody
        : Buffer.from(rawBody == null ? "" : String(rawBody), "utf8");
    const digest = crypto.createHmac("sha256", webhookSecret).update(payload).digest("hex");
    if (timingSafeEqualString(digest, signature)) {
        return { ok: true, method: "hmac" };
    }

    return { ok: false, reason: "invalid_signature" };
}

function parseWebhookEvent(body) {
    const event = body && typeof body === "object" ? body : {};
    const data = event.data && typeof event.data === "object" ? event.data : {};
    const type = String(event.type || event.event || data.type || "").trim();
    const eventId =
        event.id ||
        event.event_id ||
        data.id ||
        [type, data.session_id || data.room_id || "", event.timestamp || ""].join(":");

    return {
        eventId: String(eventId || crypto.randomUUID()),
        type,
        data,
        roomId: data.room_id || data.roomId || null,
        roomName: data.room_name || data.roomName || null,
        sessionId: data.session_id || data.sessionId || null,
        peerRole: data.role || data.peer_role || data.user_role || null,
        userId: data.user_id || data.userId || data.peer_user_id || null,
        recordingId: data.recording_id || data.asset_id || data.beam_id || null,
        recordingUrl:
            data.recording_presigned_url ||
            data.presigned_url ||
            data.url ||
            data.location ||
            data.path ||
            null,
        transcriptUrl:
            data.transcript_presigned_url ||
            data.transcript_url ||
            data.transcription_presigned_url ||
            null,
        transcriptLines: Array.isArray(data.transcript)
            ? data.transcript
            : Array.isArray(data.lines)
              ? data.lines
              : null,
        timestamp: event.timestamp || data.joined_at || data.started_at || null,
    };
}

function interviewIdFromRoomName(roomName) {
    const name = String(roomName || "");
    const match = name.match(/^interview-(.+)$/i);
    return match ? match[1] : null;
}

function extractTranscriptLines(rawLines, { candidateUserId, studentRole } = {}) {
    if (!Array.isArray(rawLines) || rawLines.length === 0) return [];

    const student = String(studentRole || getHmsConfig().roles[APP_ROLES.STUDENT] || "student").toLowerCase();
    const lines = [];

    for (const raw of rawLines) {
        if (!raw) continue;
        const text = String(raw.text || raw.message || raw.content || raw.utterance || "").trim();
        if (!text) continue;

        const role = String(raw.role || raw.speaker || raw.peer_role || "").toLowerCase();
        const userId = String(raw.user_id || raw.userId || raw.peer_id || "");
        const isCandidate =
            role === student ||
            role === "student" ||
            role === "candidate" ||
            (candidateUserId && userId && userId === String(candidateUserId));

        lines.push({
            timestamp: raw.timestamp || raw.start || raw.time || undefined,
            speaker: isCandidate ? "Candidate" : "AI",
            text,
        });
    }

    return lines;
}

async function listRecordingAssets({ sessionId, roomId } = {}) {
    const params = new URLSearchParams();
    if (sessionId) params.set("session_id", sessionId);
    if (roomId) params.set("room_id", roomId);
    const query = params.toString();
    try {
        const assets = await hmsApi(`/recording-assets${query ? `?${query}` : ""}`);
        return Array.isArray(assets?.data) ? assets.data : Array.isArray(assets) ? assets : [];
    } catch (err) {
        console.warn("[100MS] Recording asset lookup failed:", err.message);
        return [];
    }
}

function pickRecordingUrl(asset) {
    if (!asset || typeof asset !== "object") return null;
    return (
        asset.presigned_url ||
        asset.url ||
        asset.path ||
        asset.location ||
        asset.metadata?.url ||
        null
    );
}

async function downloadRecordingToDisk(interviewId, sourceUrl) {
    if (!sourceUrl || typeof sourceUrl !== "string" || !/^https?:\/\//i.test(sourceUrl)) {
        return null;
    }

    const response = await fetch(sourceUrl);
    if (!response.ok) {
        throw createHttpError(
            `Unable to download the interview recording (${response.status}).`,
            502
        );
    }

    const contentType = response.headers.get("content-type") || "";
    let ext = ".mp4";
    if (contentType.includes("audio/mpeg") || sourceUrl.includes(".mp3")) ext = ".mp3";
    else if (contentType.includes("audio/wav") || sourceUrl.includes(".wav")) ext = ".wav";
    else if (contentType.includes("webm") || sourceUrl.includes(".webm")) ext = ".webm";
    else if (sourceUrl.includes(".m3u8")) ext = ".m3u8";

    const dir = path.join(process.cwd(), process.env.OUTPUT_DIR || "output", "recordings");
    await fsp.mkdir(dir, { recursive: true });
    const filename = `${interviewId}${ext}`;
    const filepath = path.join(dir, filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
        throw createHttpError("Recording download was empty.", 502);
    }
    await fsp.writeFile(filepath, buffer);
    return {
        filepath,
        relativePath: path.posix.join(process.env.OUTPUT_DIR || "output", "recordings", filename),
        filename,
        bytes: buffer.length,
    };
}

function getConfiguredRoomId() {
    return getHmsConfig().legacyRoomId || "";
}

module.exports = {
    APP_ROLES,
    getHmsConfig,
    isHmsConfigured,
    requireHmsConfig,
    getHmsRoleForAppRole,
    resolveAppRoleFromJoinAs,
    resolveAppRoleFromHmsRole,
    generateManagementToken,
    generateAuthToken,
    createInterviewRoom,
    roomNameForInterview,
    publicWebhookUrl,
    verifyWebhookSignature,
    parseWebhookEvent,
    interviewIdFromRoomName,
    extractTranscriptLines,
    listRecordingAssets,
    pickRecordingUrl,
    downloadRecordingToDisk,
    getConfiguredRoomId,
    signAuthTokenJwt,
};
