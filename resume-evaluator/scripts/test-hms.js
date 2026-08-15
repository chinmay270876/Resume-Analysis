/**
 * 100ms integration unit tests (no network, no real secrets).
 * Run: node --test scripts/test-hms.js
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-placeholder";
process.env.NODE_ENV = "test";
process.env.HMS_APP_ACCESS_KEY = "test-access-key";
process.env.HMS_APP_SECRET = "test-app-secret-value";
process.env.HMS_TEMPLATE_ID = "test-template-id";
process.env.HMS_WEBHOOK_SECRET = "test-webhook-secret";
process.env.HMS_ROLE_INTERVIEWER = "interviewer";
process.env.HMS_ROLE_STUDENT = "student";
process.env.HMS_ROLE_ADMIN = "host";

const hms = require("../src/services/hmsTokenService");

describe("100ms role mapping", () => {
    it("maps application student role to HMS_ROLE_STUDENT", () => {
        assert.equal(hms.getHmsRoleForAppRole("student"), "student");
        assert.equal(hms.getHmsRoleForAppRole("candidate"), "student");
    });

    it("maps interviewer and spectator without trusting raw HMS names from clients", () => {
        assert.equal(hms.resolveAppRoleFromJoinAs("interviewer"), "interviewer");
        assert.equal(hms.resolveAppRoleFromJoinAs("spectator"), "admin");
        assert.equal(hms.resolveAppRoleFromJoinAs("admin"), "admin");
        assert.throws(() => hms.resolveAppRoleFromJoinAs("student"), /interviewer or spectator/);
    });

    it("uses configured HMS role names, not hardcoded literals, when env changes", () => {
        process.env.HMS_ROLE_STUDENT = "applicant";
        assert.equal(hms.getHmsRoleForAppRole("student"), "applicant");
        process.env.HMS_ROLE_STUDENT = "student";
    });
});

describe("100ms token generation", () => {
    it("signs a JWT with the requested room and role", () => {
        const token = hms.signAuthTokenJwt({
            accessKey: "ak",
            secret: "secret",
            roomId: "room-1",
            userId: "user-1",
            role: "student",
        });
        const [, payload] = token.split(".");
        const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        assert.equal(json.room_id, "room-1");
        assert.equal(json.role, "student");
        assert.equal(json.user_id, "user-1");
        assert.equal(json.type, "app");
    });

    it("fails closed when credentials are missing", () => {
        const access = process.env.HMS_APP_ACCESS_KEY;
        const secret = process.env.HMS_APP_SECRET;
        const template = process.env.HMS_TEMPLATE_ID;
        delete process.env.HMS_APP_ACCESS_KEY;
        delete process.env.HMS_APP_SECRET;
        delete process.env.HMS_TEMPLATE_ID;
        delete process.env.HMS_ACCESS_KEY;
        delete process.env.HMS_SECRET;
        delete process.env["100MS_ACCESS_KEY"];
        delete process.env["100MS_SECRET"];
        delete process.env["100MS_ROOM_ID"];
        delete process.env.HMS_ROOM_ID;
        assert.equal(hms.isHmsConfigured(), false);
        assert.throws(() => hms.requireHmsConfig(), /not configured/);
        process.env.HMS_APP_ACCESS_KEY = access;
        process.env.HMS_APP_SECRET = secret;
        process.env.HMS_TEMPLATE_ID = template;
    });
});

describe("100ms webhook signature", () => {
    const body = JSON.stringify({
        id: "evt_1",
        type: "session.open.success",
        data: { room_id: "room-1", session_id: "sess-1" },
    });

    it("accepts a valid HMAC signature", () => {
        const digest = crypto
            .createHmac("sha256", "test-webhook-secret")
            .update(Buffer.from(body))
            .digest("hex");
        const result = hms.verifyWebhookSignature({
            rawBody: body,
            headers: { "x-100ms-signature": digest },
        });
        assert.equal(result.ok, true);
        assert.equal(result.method, "hmac");
    });

    it("accepts a shared secret header", () => {
        const result = hms.verifyWebhookSignature({
            rawBody: body,
            headers: { "x-100ms-webhook-secret": "test-webhook-secret" },
        });
        assert.equal(result.ok, true);
        assert.equal(result.method, "shared-secret");
    });

    it("rejects an invalid signature", () => {
        const result = hms.verifyWebhookSignature({
            rawBody: body,
            headers: { "x-100ms-signature": "deadbeef" },
        });
        assert.equal(result.ok, false);
    });
});

describe("100ms webhook parsing and idempotency helpers", () => {
    it("parses room/session identifiers without trusting unknown fields blindly", () => {
        const parsed = hms.parseWebhookEvent({
            id: "evt_dup",
            type: "peer.join.success",
            data: { room_id: "abc", session_id: "def", role: "student", user_id: "cand-1" },
        });
        assert.equal(parsed.eventId, "evt_dup");
        assert.equal(parsed.roomId, "abc");
        assert.equal(parsed.sessionId, "def");
        assert.equal(parsed.peerRole, "student");
    });

    it("extracts interview id from the room name mapping", () => {
        assert.equal(hms.interviewIdFromRoomName("interview-uuid-1"), "uuid-1");
        assert.equal(hms.interviewIdFromRoomName("other-room"), null);
    });

    it("maps 100ms transcript speakers to AI/Candidate", () => {
        const lines = hms.extractTranscriptLines(
            [
                { role: "host", text: "Good afternoon" },
                { role: "student", text: "Good afternoon" },
            ],
            { candidateUserId: "c1" }
        );
        assert.equal(lines[0].speaker, "AI");
        assert.equal(lines[1].speaker, "Candidate");
    });
});
