const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const interviewStore = require("../services/interviewStore");

dayjs.extend(utc);

const LINK_EXPIRY_HOURS = 48;

function createHttpError(message, status = 400, stage = "interview") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

function resolveExpiresAt(interview) {
    if (!interview) return null;
    if (interview.expiresAt) {
        const parsed = dayjs.utc(interview.expiresAt);
        return parsed.isValid() ? parsed.toISOString() : null;
    }
    if (interview.scheduledAt) {
        const parsed = dayjs.utc(interview.scheduledAt);
        return parsed.isValid() ? parsed.add(LINK_EXPIRY_HOURS, "hour").toISOString() : null;
    }
    return null;
}

function isLinkExpired(interview, now = dayjs.utc()) {
    const expiresAt = resolveExpiresAt(interview);
    if (!expiresAt) return false;
    const expiry = dayjs.utc(expiresAt);
    if (!expiry.isValid()) return false;
    const instant = dayjs.isDayjs(now) ? now.utc() : dayjs.utc(now);
    return instant.isAfter(expiry);
}

/**
 * Block candidate room access after expiresAt (scheduledAt + 48h, unless extended).
 * Applied to POST /api/interviews/:id/token.
 */
async function requireActiveInterviewLink(req, res, next) {
    try {
        const id = req.params?.id;
        if (!id) {
            throw createHttpError("Interview ID is required.", 400);
        }

        const interview = await interviewStore.getInterviewById(id);
        if (!interview) {
            throw createHttpError("Interview not found.", 404);
        }

        if (isLinkExpired(interview)) {
            return res.status(403).json({
                success: false,
                error: "Link Expired",
                code: "LINK_EXPIRED",
            });
        }

        req.interview = interview;
        return next();
    } catch (error) {
        return next(error);
    }
}

module.exports = {
    LINK_EXPIRY_HOURS,
    resolveExpiresAt,
    isLinkExpired,
    requireActiveInterviewLink,
};
