const { v4: uuidv4 } = require("uuid");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");
const customParseFormat = require("dayjs/plugin/customParseFormat");

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const { isValidEmail } = require("./emailService");
const { sanitizeHttpUrl } = require("../utils/htmlEscape");
const interviewStore = require("./interviewStore");
const {
    INTERVIEW_STATUSES,
    ACTIVE_SCHEDULE_STATUSES,
    ALL_STATUSES,
} = require("../models/interviewStatuses");

function resolveMeetingLink(rawLink, interviewId) {
    const sanitized = sanitizeHttpUrl(rawLink);
    if (sanitized) {
        return sanitized;
    }
    // Built links are always http(s) from FRONTEND_URL / localhost defaults.
    return buildMeetingLink(interviewId);
}

const DEFAULT_DURATION_MINUTES = 25;
const DEFAULT_TIMEZONE = "UTC";

function createHttpError(message, status = 400, stage = "interview") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

function normalizeString(value) {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

function parseDuration(value) {
    if (value == null || value === "") {
        return DEFAULT_DURATION_MINUTES;
    }
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0 || num > 480) {
        throw createHttpError("Duration must be a positive number of minutes (max 480).");
    }
    return Math.round(num);
}

function buildMeetingLink(interviewId) {
    const base =
        process.env.FRONTEND_URL ||
        process.env.CORS_ORIGINS?.split(",")[0]?.trim() ||
        "http://localhost:4200";
    return `${base.replace(/\/$/, "")}/interviews/${interviewId}`;
}

function parseInterviewDateTime(date, time, tz) {
    const dateStr = normalizeString(date);
    const timeStr = normalizeString(time);
    const zone = normalizeString(tz) || DEFAULT_TIMEZONE;

    if (!dateStr || !timeStr) {
        return null;
    }

    // Accept HH:mm or HH:mm:ss
    const formats = ["YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm:ss"];
    let parsed = null;
    for (const format of formats) {
        const candidate = dayjs.tz(`${dateStr} ${timeStr}`, format, zone);
        if (candidate.isValid()) {
            parsed = candidate;
            break;
        }
    }

    if (!parsed || !parsed.isValid()) {
        throw createHttpError("Invalid date, time, or timezone.");
    }

    return parsed;
}

function computeReminderStatus(interview) {
    const reminders = interview.reminders || {};
    const sent = [];
    if (reminders.sent24h) sent.push("24h");
    if (reminders.sent1h) sent.push("1h");
    if (reminders.sent10m) sent.push("10m");

    if (sent.length === 0) {
        return {
            label: "Not Sent",
            sent24h: false,
            sent1h: false,
            sent10m: false,
            sent,
        };
    }

    return {
        label: `Sent (${sent.join(", ")})`,
        sent24h: !!reminders.sent24h,
        sent1h: !!reminders.sent1h,
        sent10m: !!reminders.sent10m,
        sent,
    };
}

function enrichInterview(interview) {
    if (!interview) return null;
    return {
        ...interview,
        reminderStatus: computeReminderStatus(interview),
    };
}

function validateScheduleFields(payload, { requireSchedule = true } = {}) {
    const candidateName = normalizeString(payload.candidateName);
    const candidateEmail = normalizeString(payload.candidateEmail);
    const date = normalizeString(payload.date);
    const time = normalizeString(payload.time);
    const timezoneValue = normalizeString(payload.timezone) || DEFAULT_TIMEZONE;

    if (!candidateName) {
        throw createHttpError("Candidate Name is required.");
    }
    if (!candidateEmail) {
        throw createHttpError("Candidate Email is required.");
    }
    if (!isValidEmail(candidateEmail)) {
        throw createHttpError("Invalid candidate email address.");
    }

    if (requireSchedule) {
        if (!date) {
            throw createHttpError("Interview date is required.");
        }
        if (!time) {
            throw createHttpError("Interview time is required.");
        }
    }

    let scheduledAt = null;
    if (date && time) {
        scheduledAt = parseInterviewDateTime(date, time, timezoneValue);
        if (scheduledAt.isBefore(dayjs())) {
            throw createHttpError("Cannot schedule an interview in the past.");
        }
    }

    const durationMinutes = parseDuration(payload.duration ?? payload.durationMinutes);

    return {
        candidateName,
        candidateEmail: candidateEmail.toLowerCase(),
        date: date || null,
        time: time || null,
        timezone: timezoneValue,
        durationMinutes,
        scheduledAtIso: scheduledAt ? scheduledAt.toISOString() : null,
    };
}

async function assertNoDuplicateSlot({
    candidateEmail,
    date,
    time,
    excludeId = null,
}) {
    if (!date || !time) return;

    const interviews = await interviewStore.getAllInterviews();
    const conflict = interviews.find((item) => {
        if (excludeId && item.id === excludeId) return false;
        if (item.status === INTERVIEW_STATUSES.CANCELLED) return false;
        if (item.status === INTERVIEW_STATUSES.EXPIRED) return false;
        return (
            normalizeString(item.candidateEmail).toLowerCase() === candidateEmail.toLowerCase() &&
            item.date === date &&
            item.time === time
        );
    });

    if (conflict) {
        throw createHttpError(
            "An interview for this candidate is already scheduled at the same date and time."
        );
    }
}

function buildInterviewRecord(payload, schedule) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const status =
        payload.status && ALL_STATUSES.includes(payload.status)
            ? payload.status
            : schedule.date && schedule.time
                ? INTERVIEW_STATUSES.SCHEDULED
                : INTERVIEW_STATUSES.DRAFT;

    return {
        id,
        candidateId: normalizeString(payload.candidateId) || id,
        resumeId: normalizeString(payload.resumeId) || null,
        jdId: normalizeString(payload.jdId) || null,
        candidateName: schedule.candidateName,
        candidateEmail: schedule.candidateEmail,
        resumeSummary: payload.resumeSummary || payload.analysis || null,
        jobDescription: payload.jobDescription || payload.jdAnalysis || null,
        interviewJson: payload.interviewJson || payload.interview || null,
        date: schedule.date,
        time: schedule.time,
        timezone: schedule.timezone,
        durationMinutes: schedule.durationMinutes,
        scheduledAt: schedule.scheduledAtIso,
        meetingLink: resolveMeetingLink(payload.meetingLink, id),
        status,
        reminders: {
            sent24h: false,
            sent1h: false,
            sent10m: false,
        },
        invitationSent: false,
        invitationSentAt: null,
        createdAt: now,
        updatedAt: now,
    };
}

async function createInterview(payload) {
    const asDraft = payload.status === INTERVIEW_STATUSES.DRAFT || payload.saveAsDraft === true;
    const schedule = validateScheduleFields(payload, { requireSchedule: !asDraft });

    await assertNoDuplicateSlot({
        candidateEmail: schedule.candidateEmail,
        date: schedule.date,
        time: schedule.time,
    });

    const record = buildInterviewRecord(
        { ...payload, status: asDraft ? INTERVIEW_STATUSES.DRAFT : payload.status },
        schedule
    );

    const created = await interviewStore.createInterview(record);
    return enrichInterview(created);
}

async function listInterviews(filters = {}) {
    let interviews = await interviewStore.getAllInterviews();

    // Auto-expire past scheduled interviews that never completed
    const now = dayjs();
    const updates = [];
    interviews = interviews.map((item) => {
        if (
            ACTIVE_SCHEDULE_STATUSES.includes(item.status) &&
            item.scheduledAt &&
            dayjs(item.scheduledAt)
                .add(item.durationMinutes || DEFAULT_DURATION_MINUTES, "minute")
                .isBefore(now)
        ) {
            const expired = {
                ...item,
                status: INTERVIEW_STATUSES.EXPIRED,
                updatedAt: new Date().toISOString(),
            };
            updates.push(expired);
            return expired;
        }
        return item;
    });

    for (const expired of updates) {
        await interviewStore.updateInterview(expired.id, () => expired);
    }

    if (filters.status) {
        const statuses = Array.isArray(filters.status)
            ? filters.status
            : String(filters.status).split(",").map((s) => s.trim());
        interviews = interviews.filter((item) => statuses.includes(item.status));
    }

    if (filters.filter === "upcoming") {
        interviews = interviews.filter(
            (item) =>
                ACTIVE_SCHEDULE_STATUSES.includes(item.status) &&
                item.scheduledAt &&
                dayjs(item.scheduledAt).isAfter(now)
        );
    } else if (filters.filter === "today") {
        interviews = interviews.filter((item) => {
            if (!item.scheduledAt) return false;
            if (item.status === INTERVIEW_STATUSES.CANCELLED) return false;
            const zone = item.timezone || DEFAULT_TIMEZONE;
            return dayjs(item.scheduledAt).tz(zone).isSame(dayjs().tz(zone), "day");
        });
    } else if (filters.filter === "completed") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.COMPLETED);
    } else if (filters.filter === "cancelled") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.CANCELLED);
    }

    interviews.sort((a, b) => {
        const aTime = a.scheduledAt ? dayjs(a.scheduledAt).valueOf() : 0;
        const bTime = b.scheduledAt ? dayjs(b.scheduledAt).valueOf() : 0;
        return aTime - bTime;
    });

    return interviews.map(enrichInterview);
}

async function getInterview(id) {
    const interview = await interviewStore.getInterviewById(id);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }
    return enrichInterview(interview);
}

async function updateInterview(id, payload) {
    const existing = await interviewStore.getInterviewById(id);
    if (!existing) {
        throw createHttpError("Interview not found.", 404);
    }

    const statusOnlyUpdate =
        payload.status &&
        Object.keys(payload).every((key) =>
            ["status"].includes(key)
        );

    if (statusOnlyUpdate) {
        if (!ALL_STATUSES.includes(payload.status)) {
            throw createHttpError(`Invalid status. Allowed: ${ALL_STATUSES.join(", ")}`);
        }
        const updated = await interviewStore.updateInterview(id, (current) => ({
            ...current,
            status: payload.status,
            updatedAt: new Date().toISOString(),
        }));
        return enrichInterview(updated);
    }

    const nextPayload = {
        candidateName: payload.candidateName ?? existing.candidateName,
        candidateEmail: payload.candidateEmail ?? existing.candidateEmail,
        date: payload.date ?? existing.date,
        time: payload.time ?? existing.time,
        timezone: payload.timezone ?? existing.timezone,
        duration: payload.duration ?? payload.durationMinutes ?? existing.durationMinutes,
    };

    const scheduleFieldsChanging = !!(payload.date || payload.time || payload.timezone);
    const requireSchedule =
        (payload.status || existing.status) !== INTERVIEW_STATUSES.DRAFT &&
        (payload.status || existing.status) !== INTERVIEW_STATUSES.CANCELLED &&
        (payload.status || existing.status) !== INTERVIEW_STATUSES.COMPLETED;

    // Reuse field validators without forcing "not in the past" when only
    // non-schedule fields change on an already-scheduled interview.
    const candidateName = normalizeString(nextPayload.candidateName);
    const candidateEmail = normalizeString(nextPayload.candidateEmail);
    if (!candidateName) throw createHttpError("Candidate Name is required.");
    if (!candidateEmail) throw createHttpError("Candidate Email is required.");
    if (!isValidEmail(candidateEmail)) {
        throw createHttpError("Invalid candidate email address.");
    }

    const date = normalizeString(nextPayload.date);
    const time = normalizeString(nextPayload.time);
    const timezoneValue = normalizeString(nextPayload.timezone) || DEFAULT_TIMEZONE;
    const durationMinutes = parseDuration(nextPayload.duration);

    if (requireSchedule && (!date || !time)) {
        throw createHttpError("Interview date and time are required.");
    }

    let scheduledAtIso = existing.scheduledAt;
    if (date && time) {
        const scheduledAt = parseInterviewDateTime(date, time, timezoneValue);
        scheduledAtIso = scheduledAt.toISOString();
        if (scheduleFieldsChanging && scheduledAt.isBefore(dayjs())) {
            throw createHttpError("Cannot schedule an interview in the past.");
        }
    }

    await assertNoDuplicateSlot({
        candidateEmail: candidateEmail.toLowerCase(),
        date: date || null,
        time: time || null,
        excludeId: id,
    });

    if (payload.status && !ALL_STATUSES.includes(payload.status)) {
        throw createHttpError(`Invalid status. Allowed: ${ALL_STATUSES.join(", ")}`);
    }

    const updated = await interviewStore.updateInterview(id, (current) => {
        const now = new Date().toISOString();
        return {
            ...current,
            candidateName,
            candidateEmail: candidateEmail.toLowerCase(),
            date: date || null,
            time: time || null,
            timezone: timezoneValue,
            durationMinutes,
            scheduledAt: scheduledAtIso,
            meetingLink: payload.meetingLink !== undefined
                ? (sanitizeHttpUrl(payload.meetingLink) || current.meetingLink)
                : current.meetingLink,
            status: payload.status || current.status,
            resumeSummary:
                payload.resumeSummary !== undefined
                    ? payload.resumeSummary
                    : payload.analysis !== undefined
                        ? payload.analysis
                        : current.resumeSummary,
            jobDescription:
                payload.jobDescription !== undefined
                    ? payload.jobDescription
                    : payload.jdAnalysis !== undefined
                        ? payload.jdAnalysis
                        : current.jobDescription,
            interviewJson:
                payload.interviewJson !== undefined
                    ? payload.interviewJson
                    : payload.interview !== undefined
                        ? payload.interview
                        : current.interviewJson,
            resumeId: payload.resumeId !== undefined ? payload.resumeId : current.resumeId,
            jdId: payload.jdId !== undefined ? payload.jdId : current.jdId,
            updatedAt: now,
        };
    });

    return enrichInterview(updated);
}

async function removeInterview(id) {
    const deleted = await interviewStore.deleteInterview(id);
    if (!deleted) {
        throw createHttpError("Interview not found.", 404);
    }
    return true;
}

async function markInvitationSent(id) {
    return enrichInterview(
        await interviewStore.updateInterview(id, (current) => ({
            ...current,
            invitationSent: true,
            invitationSentAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }))
    );
}

async function markReminderSent(id, reminderKey) {
    const keyMap = {
        "24h": "sent24h",
        "1h": "sent1h",
        "10m": "sent10m",
    };
    const field = keyMap[reminderKey];
    if (!field) return null;

    return enrichInterview(
        await interviewStore.updateInterview(id, (current) => {
            const reminders = { ...(current.reminders || {}) };
            reminders[field] = true;
            const nextStatus =
                current.status === INTERVIEW_STATUSES.SCHEDULED
                    ? INTERVIEW_STATUSES.REMINDER_SENT
                    : current.status;
            return {
                ...current,
                reminders,
                status: nextStatus,
                updatedAt: new Date().toISOString(),
            };
        })
    );
}

module.exports = {
    INTERVIEW_STATUSES,
    DEFAULT_DURATION_MINUTES,
    createInterview,
    listInterviews,
    getInterview,
    updateInterview,
    removeInterview,
    markInvitationSent,
    markReminderSent,
    enrichInterview,
    buildMeetingLink,
    parseInterviewDateTime,
};
