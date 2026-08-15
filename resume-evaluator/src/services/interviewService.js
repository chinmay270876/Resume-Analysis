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
    LINK_EXPIRY_HOURS,
    resolveExpiresAt,
    isLinkExpired,
} = require("../middleware/interviewLinkExpiry");
const {
    INTERVIEW_STATUSES,
    INTERVIEW_RESULTS,
    ACTIVE_SCHEDULE_STATUSES,
    POST_COMPLETION_STATUSES,
    ALL_STATUSES,
    ALL_RESULTS,
} = require("../models/interviewStatuses");

function resolveMeetingLink(rawLink, interviewId) {
    const sanitized = sanitizeHttpUrl(rawLink);
    if (sanitized) {
        return normalizeMeetingLink(sanitized, interviewId);
    }
    // Built links are always http(s) from FRONTEND_URL / localhost defaults.
    return buildMeetingLink(interviewId);
}

const DEFAULT_DURATION_MINUTES = 25;
const DEFAULT_TIMEZONE = "UTC";
const LINK_EXTEND_HOURS = 24;
const MAX_SESSION_MINUTES = 30;
const MAX_INTERVIEW_QUESTIONS = 10;

/** Standard reminder offsets (minutes before scheduledAt). Kept in sync with reminder service defaults. */
const REMINDER_OFFSET_MINUTES = Object.freeze({
    "24h": 1440,
    "1h": 60,
    "30m": 30,
    "10m": 10,
});

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

function isLocalFrontendHost(value) {
    try {
        const host = new URL(value).hostname.toLowerCase();
        return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
    } catch {
        return true;
    }
}

function frontendBaseUrl() {
    const configured = String(process.env.FRONTEND_URL || "").trim();
    if (configured) {
        return configured.replace(/\/$/, "");
    }

    const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
    if (isProd) {
        console.error("[EMAIL] FRONTEND_URL is not configured in production");
    }

    const corsBase = String(process.env.CORS_ORIGINS || "")
        .split(",")
        .map((part) => part.trim())
        .find((part) => part && !isLocalFrontendHost(part));
    if (corsBase) {
        return corsBase.replace(/\/$/, "");
    }

    if (isProd) {
        return "https://resume-analysis-b7p7.onrender.com";
    }

    return "http://localhost:4200";
}

function buildMeetingLink(interviewId) {
    const base = frontendBaseUrl();
    return `${base.replace(/\/$/, "")}/candidate-interview/${interviewId}`;
}

/** Rewrite legacy recruiter /interviews/:id links to the candidate room path. */
function normalizeMeetingLink(link, interviewId) {
    if (!link || typeof link !== "string") {
        return buildMeetingLink(interviewId);
    }
    try {
        const rewritten = link.replace(/\/interviews\/([^/?#]+)/, "/candidate-interview/$1");
        return sanitizeHttpUrl(rewritten) || buildMeetingLink(interviewId);
    } catch {
        return buildMeetingLink(interviewId);
    }
}

function parseMaybeJson(value) {
    if (!value) return null;
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
    return typeof value === "object" ? value : null;
}

function questionTextFrom(raw) {
    if (typeof raw === "string") return raw.trim();
    if (!raw || typeof raw !== "object") return "";
    for (const key of ["question", "text", "prompt", "q"]) {
        if (typeof raw[key] === "string" && raw[key].trim()) {
            return raw[key].trim();
        }
    }
    return "";
}

function collectQuestionsFromList(list, sectionName = "") {
    const questions = [];
    if (!Array.isArray(list)) return questions;
    for (const q of list) {
        if (q && typeof q === "object" && Array.isArray(q.questions)) {
            questions.push(
                ...collectQuestionsFromList(q.questions, q.sectionName || sectionName)
            );
            continue;
        }
        const text = questionTextFrom(q);
        if (!text) continue;
        questions.push({
            questionNo: 0,
            question: text,
            category: (q && q.category) || sectionName || null,
            difficulty: (q && q.difficulty) || null,
            estimatedTime: (q && q.estimatedTime) || null,
            sectionName: (q && q.sectionName) || sectionName || null,
        });
    }
    return questions;
}

/**
 * Flatten structured interview sections into an ordered question list for the live room.
 */
function extractInterviewQuestions(interview) {
    const structured =
        parseMaybeJson(interview?.interviewJson) ||
        parseMaybeJson(interview?.interview) ||
        null;

    const sections = Array.isArray(structured?.sections)
        ? structured.sections
        : Array.isArray(structured?.interview?.sections)
          ? structured.interview.sections
          : [];

    let questions = [];
    if (sections.length > 0) {
        for (const section of sections) {
            const sectionName =
                typeof section?.sectionName === "string" ? section.sectionName : "";
            questions.push(
                ...collectQuestionsFromList(
                    Array.isArray(section?.questions) ? section.questions : [],
                    sectionName
                )
            );
        }
    }

    if (questions.length === 0) {
        questions = collectQuestionsFromList(
            Array.isArray(structured?.questions)
                ? structured.questions
                : Array.isArray(interview?.questions)
                  ? interview.questions
                  : []
        );
    }

    return questions.slice(0, MAX_INTERVIEW_QUESTIONS).map((q, idx) => ({
        ...q,
        questionNo: idx + 1,
    }));
}

function emptyInterviewDetails() {
    return {
        answers: [],
        startedAt: null,
        completedAt: null,
        roomId: null,
    };
}

function normalizeInterviewDetails(details) {
    const base = emptyInterviewDetails();
    if (!details || typeof details !== "object") return base;
    return {
        answers: Array.isArray(details.answers) ? details.answers : [],
        startedAt: details.startedAt || null,
        completedAt: details.completedAt || null,
        roomId: details.roomId || null,
    };
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

function computeExpiresAt(scheduledAtIso) {
    if (!scheduledAtIso) return null;
    const scheduledAt = dayjs(scheduledAtIso);
    if (!scheduledAt.isValid()) return null;
    return scheduledAt.add(LINK_EXPIRY_HOURS, "hour").toISOString();
}

function sessionCapMinutes(durationMinutes) {
    const duration = Number(durationMinutes);
    const minutes = Number.isFinite(duration) && duration > 0
        ? duration
        : DEFAULT_DURATION_MINUTES;
    return Math.min(Math.round(minutes), MAX_SESSION_MINUTES);
}

function computeReminderTimestamps(scheduledAtIso) {
    if (!scheduledAtIso) {
        return {
            "24h": null,
            "1h": null,
            "30m": null,
            "10m": null,
        };
    }
    const scheduledAt = dayjs(scheduledAtIso);
    if (!scheduledAt.isValid()) {
        return {
            "24h": null,
            "1h": null,
            "30m": null,
            "10m": null,
        };
    }
    const timestamps = {};
    for (const [key, minutes] of Object.entries(REMINDER_OFFSET_MINUTES)) {
        timestamps[key] = scheduledAt.subtract(minutes, "minute").toISOString();
    }
    return timestamps;
}

function resolvePrimaryReminderTimestamp(reminderTimestamps) {
    return (
        reminderTimestamps?.["30m"] ||
        reminderTimestamps?.["10m"] ||
        reminderTimestamps?.["1h"] ||
        reminderTimestamps?.["24h"] ||
        null
    );
}

function emptyReminders() {
    return {
        sent24h: false,
        sent1h: false,
        sent30m: false,
        sent10m: false,
    };
}

function normalizeReminders(reminders) {
    const base = emptyReminders();
    if (!reminders || typeof reminders !== "object") return base;
    return {
        sent24h: !!reminders.sent24h,
        sent1h: !!reminders.sent1h,
        sent30m: !!reminders.sent30m,
        sent10m: !!reminders.sent10m,
    };
}

function computeReminderStatus(interview) {
    const reminders = normalizeReminders(interview.reminders);
    const sent = [];
    if (reminders.sent24h) sent.push("24h");
    if (reminders.sent1h) sent.push("1h");
    if (reminders.sent30m) sent.push("30m");
    if (reminders.sent10m) sent.push("10m");

    if (sent.length === 0) {
        return {
            label: "Pending",
            sent24h: false,
            sent1h: false,
            sent30m: false,
            sent10m: false,
            sent,
        };
    }

    return {
        label: "Sent",
        detail: sent.join(", "),
        sent24h: reminders.sent24h,
        sent1h: reminders.sent1h,
        sent30m: reminders.sent30m,
        sent10m: reminders.sent10m,
        sent,
    };
}

function resolveJobRoleFromPayload(payload) {
    const direct = normalizeString(payload?.jobRole || payload?.role || "");
    if (direct) return direct;
    const jd = payload?.jobDescription || payload?.jdAnalysis;
    if (jd && typeof jd === "object") {
        const title = normalizeString(jd.jobTitle || jd.role || "");
        if (title) return title;
    }
    const resume = payload?.resumeSummary || payload?.analysis;
    if (resume && typeof resume === "object") {
        const role = normalizeString(resume.role || resume.currentDesignation || "");
        if (role) return role;
    }
    return null;
}

function resolveCurrentCompanyFromPayload(payload) {
    const direct = normalizeString(payload?.currentCompany || "");
    if (direct) return direct;
    const resume = payload?.resumeSummary || payload?.analysis;
    if (resume && typeof resume === "object") {
        const company = normalizeString(resume.currentCompany || "");
        if (company) return company;
    }
    return null;
}

function normalizeResult(value) {
    const result = normalizeString(value);
    if (ALL_RESULTS.includes(result)) return result;
    return INTERVIEW_RESULTS.PENDING;
}

/**
 * Derive join-readiness for Voice AI integration (no fake interview).
 * waiting | ready | started | ended | unavailable
 */
function computeJoinState(interview) {
    const status = interview.status;
    if (
        status === INTERVIEW_STATUSES.CANCELLED ||
        status === INTERVIEW_STATUSES.EXPIRED ||
        status === INTERVIEW_STATUSES.DRAFT
    ) {
        return {
            state: "unavailable",
            label: status === INTERVIEW_STATUSES.CANCELLED ? "Interview Cancelled" : "Unavailable",
            message: "This interview cannot be joined.",
        };
    }
    if (POST_COMPLETION_STATUSES.includes(status)) {
        return {
            state: "ended",
            label: "Interview Completed",
            message: "This interview has finished. Review transcript and evaluation below.",
        };
    }
    if (!interview.scheduledAt) {
        return {
            state: "unavailable",
            label: "Not Scheduled",
            message: "Interview time has not been set.",
        };
    }

    const now = dayjs();
    const start = dayjs(interview.scheduledAt);
    const expiresAtIso = resolveExpiresAt(interview);
    const expiresAt = expiresAtIso ? dayjs(expiresAtIso) : null;

    if (expiresAt && now.isAfter(expiresAt)) {
        return {
            state: "ended",
            label: "Interview Link Expired",
            message: "This interview link is no longer valid.",
        };
    }

    if (now.isBefore(start)) {
        return {
            state: "ready",
            label: "Interview Ready",
            message: "Waiting for scheduled time",
        };
    }
    if (
        status === INTERVIEW_STATUSES.IN_PROGRESS ||
        (expiresAt && (now.isBefore(expiresAt) || now.isSame(expiresAt)))
    ) {
        return {
            state: "started",
            label: "Interview Started",
            message: "Voice AI Interview Agent will join this session.",
        };
    }
    return {
        state: "ended",
        label: "Interview Window Closed",
        message: "The scheduled interview window has ended.",
    };
}

function hasCompletedArtifacts(interview) {
    return (
        POST_COMPLETION_STATUSES.includes(interview.status) &&
        !!(interview.transcriptPath || interview.recordingPath || interview.evaluationPath || interview.transcriptId)
    );
}

function isPostCompletion(status) {
    return POST_COMPLETION_STATUSES.includes(status);
}

function enrichInterview(interview) {
    if (!interview) return null;
    const reminderTimestamps =
        interview.reminderTimestamps || computeReminderTimestamps(interview.scheduledAt);
    const reminders = normalizeReminders(interview.reminders);
    const reminderSent =
        interview.reminderSent === true ||
        reminders.sent24h ||
        reminders.sent1h ||
        reminders.sent30m ||
        reminders.sent10m;
    const result = normalizeResult(interview.result);
    const currentCompany =
        interview.currentCompany ||
        resolveCurrentCompanyFromPayload({ resumeSummary: interview.resumeSummary }) ||
        null;
    const jobRole =
        interview.jobRole ||
        resolveJobRoleFromPayload({
            jobDescription: interview.jobDescription,
            resumeSummary: interview.resumeSummary,
        }) ||
        null;

    const interviewDetails = normalizeInterviewDetails(interview.interviewDetails);
    const questions = extractInterviewQuestions(interview);
    const meetingLink = normalizeMeetingLink(interview.meetingLink, interview.id);
    const expiresAt = resolveExpiresAt(interview);
    const linkExpired = isLinkExpired({ ...interview, expiresAt });
    const capMinutes = sessionCapMinutes(interview.durationMinutes);

    const enriched = {
        ...interview,
        expiresAt,
        linkExpired,
        canExtendLink:
            !linkExpired &&
            !!expiresAt &&
            ACTIVE_SCHEDULE_STATUSES.includes(interview.status),
        sessionCapMinutes: capMinutes,
        jobRole,
        currentCompany,
        interviewer: interview.interviewer || null,
        result,
        transcriptId: interview.transcriptId || null,
        transcriptPath: interview.transcriptPath || null,
        recordingPath: interview.recordingPath || null,
        evaluationPath: interview.evaluationPath || null,
        evaluation: interview.evaluation || null,
        evaluationId: interview.evaluationId || null,
        resultGeneratedAt: interview.resultGeneratedAt || null,
        resultHistory: Array.isArray(interview.resultHistory) ? interview.resultHistory : [],
        transcriptMeta: interview.transcriptMeta || null,
        excelSummaryPath: interview.excelSummaryPath || null,
        excelSummaryFilename: interview.excelSummaryFilename || null,
        excelSummaryUrl: interview.excelSummaryUrl || null,
        interviewDetails,
        questions,
        meetingLink,
        hmsRoomId: interview.hmsRoomId || interviewDetails.roomId || null,
        hmsRoomName: interview.hmsRoomName || null,
        hmsSessionId: interview.hmsSessionId || null,
        hmsStartedAt: interview.hmsStartedAt || null,
        hmsEndedAt: interview.hmsEndedAt || null,
        hmsCandidateJoinedAt: interview.hmsCandidateJoinedAt || null,
        hmsInterviewerJoinedAt: interview.hmsInterviewerJoinedAt || null,
        recordingStatus: interview.recordingStatus || (interview.recordingPath ? "available" : null),
        transcriptStatus:
            interview.transcriptStatus ||
            (interview.transcriptId || interview.transcriptPath ? "available" : null),
        // Canonical + alias fields for dashboard / reminder pipeline clarity
        interviewDate: interview.interviewDate || interview.date || null,
        interviewTime: interview.interviewTime || interview.time || null,
        scheduledTimestamp: interview.scheduledTimestamp || interview.scheduledAt || null,
        reminderTimestamps,
        reminderTimestamp:
            interview.reminderTimestamp || resolvePrimaryReminderTimestamp(reminderTimestamps),
        reminders,
        reminderSent,
        reminderStatus: computeReminderStatus({ ...interview, reminders }),
    };

    // Soft backfill for interviews finalized before result-history tracking.
    if (
        enriched.resultHistory.length === 0 &&
        interview.evaluation &&
        (result === INTERVIEW_RESULTS.SELECTED || result === INTERVIEW_RESULTS.REJECTED)
    ) {
        const generatedAt =
            interview.resultGeneratedAt ||
            interview.evaluation.evaluatedAt ||
            interview.updatedAt ||
            new Date().toISOString();
        enriched.resultHistory = [
            {
                interviewId: interview.id,
                evaluationId: interview.evaluationId || interview.evaluation.evaluationId || interview.id,
                result,
                overallScore: interview.evaluation.overallScore ?? null,
                jdMatchPercent:
                    interview.evaluation.jdMatchPercent ??
                    interview.evaluation.jdMatch?.score ??
                    null,
                recommendation: interview.evaluation.recommendation || null,
                generatedAt,
                generatedDate: String(generatedAt).slice(0, 10),
                generatedTime: String(generatedAt).slice(11, 19),
            },
        ];
        if (!enriched.evaluationId) {
            enriched.evaluationId = enriched.resultHistory[0].evaluationId;
        }
        if (!enriched.resultGeneratedAt) {
            enriched.resultGeneratedAt = generatedAt;
        }
    }

    enriched.joinState = computeJoinState(enriched);
    enriched.artifactsAvailable = hasCompletedArtifacts(enriched);
    enriched.isCompleted = isPostCompletion(enriched.status);
    try {
        const { buildDownloadableFiles } = require("./interviewResultService");
        enriched.downloadableFiles =
            interview.downloadableFiles || buildDownloadableFiles(enriched);
    } catch {
        enriched.downloadableFiles = interview.downloadableFiles || null;
    }
    return enriched;
}

/**
 * Auto-advance Scheduled / Reminder Sent → In Progress when inside the time window,
 * and expire past windows that never completed.
 */
function applyLifecycleTransitions(item, now = dayjs()) {
    if (!ACTIVE_SCHEDULE_STATUSES.includes(item.status) || !item.scheduledAt) {
        return { item, changed: false };
    }

    const start = dayjs(item.scheduledAt);
    const expiresAtIso = resolveExpiresAt(item);
    const expiresAt = expiresAtIso ? dayjs(expiresAtIso) : null;
    const sessionEnd = start.add(sessionCapMinutes(item.durationMinutes), "minute");
    const updatedAt = new Date().toISOString();

    if (expiresAt && expiresAt.isBefore(now)) {
        return {
            item: {
                ...item,
                expiresAt: expiresAtIso,
                status: INTERVIEW_STATUSES.EXPIRED,
                updatedAt,
            },
            changed: true,
        };
    }

    if (
        !start.isAfter(now) &&
        now.isBefore(sessionEnd) &&
        (item.status === INTERVIEW_STATUSES.SCHEDULED ||
            item.status === INTERVIEW_STATUSES.REMINDER_SENT)
    ) {
        return {
            item: {
                ...item,
                expiresAt: item.expiresAt || expiresAtIso,
                status: INTERVIEW_STATUSES.IN_PROGRESS,
                updatedAt,
            },
            changed: true,
        };
    }

    return { item, changed: false };
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

    const reminderTimestamps = computeReminderTimestamps(schedule.scheduledAtIso);
    const jobRole = resolveJobRoleFromPayload(payload);

    console.log("[Interview] Interview created — reminder scheduled", {
        store: interviewStore.STORE_FILEPATH,
        candidateName: schedule.candidateName,
        candidateEmail: schedule.candidateEmail,
        interviewDate: schedule.date,
        interviewTime: schedule.time,
        timezone: schedule.timezone,
        scheduledTimestamp: schedule.scheduledAtIso,
        reminderTimestamp: resolvePrimaryReminderTimestamp(reminderTimestamps),
        reminderTimestamps,
        status,
    });

    return {
        id,
        candidateId: normalizeString(payload.candidateId) || id,
        resumeId: normalizeString(payload.resumeId) || null,
        jdId: normalizeString(payload.jdId) || null,
        candidateName: schedule.candidateName,
        candidateEmail: schedule.candidateEmail,
        jobRole,
        currentCompany: resolveCurrentCompanyFromPayload(payload),
        interviewer: normalizeString(payload.interviewer) || null,
        resumeSummary: payload.resumeSummary || payload.analysis || null,
        jobDescription: payload.jobDescription || payload.jdAnalysis || null,
        interviewJson: payload.interviewJson || payload.interview || null,
        date: schedule.date,
        time: schedule.time,
        // Alias fields required by the reminder pipeline contract
        interviewDate: schedule.date,
        interviewTime: schedule.time,
        timezone: schedule.timezone,
        durationMinutes: schedule.durationMinutes,
        scheduledAt: schedule.scheduledAtIso,
        scheduledTimestamp: schedule.scheduledAtIso,
        expiresAt: computeExpiresAt(schedule.scheduledAtIso),
        reminderTimestamps,
        reminderTimestamp: resolvePrimaryReminderTimestamp(reminderTimestamps),
        meetingLink: resolveMeetingLink(payload.meetingLink, id),
        status,
        reminders: emptyReminders(),
        reminderSent: false,
        invitationSent: false,
        invitationSentAt: null,
        interviewDetails: emptyInterviewDetails(),
        hmsRoomId: null,
        hmsRoomName: null,
        hmsSessionId: null,
        hmsRoomCode: null,
        hmsStartedAt: null,
        hmsEndedAt: null,
        hmsRecordingId: null,
        hmsCandidateJoinedAt: null,
        hmsInterviewerJoinedAt: null,
        recordingStatus: null,
        transcriptStatus: null,
        hmsProcessedEventIds: [],
        // Post-interview artifacts — populated only after live Voice AI completes
        transcriptId: null,
        transcriptPath: null,
        recordingPath: null,
        evaluationPath: null,
        evaluation: null,
        transcriptMeta: null,
        result: INTERVIEW_RESULTS.PENDING,
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
    const withRoom = await attachHmsRoom(created);
    return enrichInterview(withRoom || created);
}

async function listInterviews(filters = {}) {
    let interviews = await interviewStore.getAllInterviews();

    // Auto-expire past interviews and promote active ones to In Progress
    const now = dayjs();
    const updates = [];
    interviews = interviews.map((item) => {
        const { item: next, changed } = applyLifecycleTransitions(item, now);
        if (changed) updates.push(next);
        return next;
    });

    for (const changed of updates) {
        await interviewStore.updateInterview(changed.id, () => changed);
    }

    const search = normalizeString(filters.search || filters.q || "").toLowerCase();
    if (search) {
        interviews = interviews.filter((item) => {
            const company =
                item.currentCompany ||
                resolveCurrentCompanyFromPayload({ resumeSummary: item.resumeSummary }) ||
                "";
            const role =
                item.jobRole ||
                resolveJobRoleFromPayload({
                    jobDescription: item.jobDescription,
                    resumeSummary: item.resumeSummary,
                }) ||
                "";
            const haystack = [
                item.candidateName,
                item.candidateEmail,
                company,
                role,
                item.status,
                item.result,
                item.interviewer,
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            return haystack.includes(search);
        });
    }

    // Result filters (Selected / Rejected) vs lifecycle status filters
    const resultFilter = normalizeString(filters.result);
    if (resultFilter && ALL_RESULTS.includes(resultFilter)) {
        interviews = interviews.filter(
            (item) => normalizeResult(item.result) === resultFilter
        );
    }

    if (filters.status) {
        const statuses = Array.isArray(filters.status)
            ? filters.status
            : String(filters.status).split(",").map((s) => s.trim());
        interviews = interviews.filter((item) => statuses.includes(item.status));
    }

    const filter = normalizeString(filters.filter || "all").toLowerCase();
    if (filter === "upcoming") {
        interviews = interviews.filter(
            (item) =>
                ACTIVE_SCHEDULE_STATUSES.includes(item.status) &&
                item.scheduledAt &&
                dayjs(item.scheduledAt).isAfter(now)
        );
    } else if (filter === "today") {
        interviews = interviews.filter((item) => {
            if (!item.scheduledAt) return false;
            if (item.status === INTERVIEW_STATUSES.CANCELLED) return false;
            const zone = item.timezone || DEFAULT_TIMEZONE;
            return dayjs(item.scheduledAt).tz(zone).isSame(dayjs().tz(zone), "day");
        });
    } else if (filter === "completed") {
        interviews = interviews.filter((item) => POST_COMPLETION_STATUSES.includes(item.status));
    } else if (filter === "cancelled") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.CANCELLED);
    } else if (filter === "scheduled") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.SCHEDULED);
    } else if (filter === "reminder sent" || filter === "reminder_sent" || filter === "remindersent") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.REMINDER_SENT);
    } else if (filter === "in progress" || filter === "in_progress" || filter === "inprogress") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.IN_PROGRESS);
    } else if (filter === "selected") {
        interviews = interviews.filter(
            (item) => normalizeResult(item.result) === INTERVIEW_RESULTS.SELECTED
        );
    } else if (filter === "rejected") {
        interviews = interviews.filter(
            (item) => normalizeResult(item.result) === INTERVIEW_RESULTS.REJECTED
        );
    } else if (filter === "pending" || filter === "pending result" || filter === "pending_result") {
        interviews = interviews.filter(
            (item) => normalizeResult(item.result) === INTERVIEW_RESULTS.PENDING
        );
    } else if (
        filter === "pending evaluation" ||
        filter === "pending_evaluation" ||
        filter === "pendingevaluation"
    ) {
        interviews = interviews.filter((item) => {
            const result = normalizeResult(item.result);
            return (
                (POST_COMPLETION_STATUSES.includes(item.status) &&
                    result === INTERVIEW_RESULTS.PENDING) ||
                item.status === INTERVIEW_STATUSES.COMPLETED ||
                item.status === INTERVIEW_STATUSES.TRANSCRIPT_GENERATED ||
                item.status === INTERVIEW_STATUSES.EVALUATION_GENERATED
            );
        });
    } else if (filter === "expired") {
        interviews = interviews.filter((item) => item.status === INTERVIEW_STATUSES.EXPIRED);
    }
    // filter === "all" or unknown → no additional filter

    const sortBy = normalizeString(filters.sortBy || filters.sort || "date").toLowerCase();
    const sortDir = normalizeString(filters.sortDir || filters.order || "asc").toLowerCase() === "desc"
        ? "desc"
        : "asc";
    const dir = sortDir === "desc" ? -1 : 1;

    const overallScoreOf = (item) => {
        const score = item?.evaluation?.overallScore;
        return score != null && Number.isFinite(Number(score)) ? Number(score) : -1;
    };
    const jdMatchOf = (item) => {
        const nested = item?.evaluation?.jdMatch;
        const flat = item?.evaluation?.jdMatchPercent;
        if (nested && typeof nested === "object" && nested.score != null) {
            return Number(nested.score);
        }
        if (flat != null && Number.isFinite(Number(flat))) return Number(flat);
        return -1;
    };
    const technicalOf = (item) => {
        const nested = item?.evaluation?.technicalKnowledge;
        const flat = item?.evaluation?.technicalScore;
        if (nested && typeof nested === "object" && nested.score != null) {
            return Number(nested.score);
        }
        if (flat != null && Number.isFinite(Number(flat))) return Number(flat);
        return -1;
    };

    interviews.sort((a, b) => {
        let cmp = 0;
        if (sortBy === "name" || sortBy === "candidate" || sortBy === "candidatename") {
            cmp = (a.candidateName || "").localeCompare(b.candidateName || "", undefined, {
                sensitivity: "base",
            });
        } else if (sortBy === "result") {
            cmp = normalizeResult(a.result).localeCompare(normalizeResult(b.result));
        } else if (sortBy === "status") {
            cmp = (a.status || "").localeCompare(b.status || "");
        } else if (
            sortBy === "score" ||
            sortBy === "overallscore" ||
            sortBy === "overall_score" ||
            sortBy === "overall"
        ) {
            cmp = overallScoreOf(a) - overallScoreOf(b);
        } else if (
            sortBy === "jdmatch" ||
            sortBy === "jd_match" ||
            sortBy === "jd" ||
            sortBy === "match"
        ) {
            cmp = jdMatchOf(a) - jdMatchOf(b);
        } else if (
            sortBy === "technical" ||
            sortBy === "technicalscore" ||
            sortBy === "technical_score"
        ) {
            cmp = technicalOf(a) - technicalOf(b);
        } else {
            // date (default)
            const aTime = a.scheduledAt ? dayjs(a.scheduledAt).valueOf() : 0;
            const bTime = b.scheduledAt ? dayjs(b.scheduledAt).valueOf() : 0;
            cmp = aTime - bTime;
        }
        return cmp * dir;
    });

    const total = interviews.length;
    const pageSizeRaw = Number(filters.pageSize ?? filters.limit ?? 10);
    const pageSize = Number.isFinite(pageSizeRaw)
        ? Math.min(Math.max(Math.round(pageSizeRaw), 1), 100)
        : 10;
    const pageRaw = Number(filters.page ?? 1);
    const page = Number.isFinite(pageRaw) ? Math.max(Math.round(pageRaw), 1) : 1;
    const totalPages = Math.max(Math.ceil(total / pageSize), 1);
    const safePage = Math.min(page, totalPages);
    const startIdx = (safePage - 1) * pageSize;
    const pageItems = interviews.slice(startIdx, startIdx + pageSize);

    return {
        interviews: pageItems.map(enrichInterview),
        pagination: {
            page: safePage,
            pageSize,
            total,
            totalPages,
        },
    };
}

async function getInterview(id) {
    let interview = await interviewStore.getInterviewById(id);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }

    const { item: next, changed } = applyLifecycleTransitions(interview, dayjs());
    if (changed) {
        interview = await interviewStore.updateInterview(id, () => next);
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
        Object.keys(payload).every((key) => ["status"].includes(key));

    const resultOnlyUpdate =
        payload.result !== undefined &&
        Object.keys(payload).every((key) => ["result"].includes(key));

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

    if (resultOnlyUpdate) {
        if (!ALL_RESULTS.includes(payload.result)) {
            throw createHttpError(`Invalid result. Allowed: ${ALL_RESULTS.join(", ")}`);
        }
        const updated = await interviewStore.updateInterview(id, (current) => ({
            ...current,
            result: payload.result,
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

    const scheduleFieldsChanging = !!(
        payload.date ||
        payload.time ||
        payload.timezone ||
        payload.duration != null ||
        payload.durationMinutes != null
    );
    const nextStatusHint = payload.status || existing.status;
    const requireSchedule =
        nextStatusHint !== INTERVIEW_STATUSES.DRAFT &&
        nextStatusHint !== INTERVIEW_STATUSES.CANCELLED &&
        !POST_COMPLETION_STATUSES.includes(nextStatusHint);

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

    const scheduleActuallyChanged =
        scheduleFieldsChanging &&
        (existing.scheduledAt !== scheduledAtIso ||
            existing.date !== (date || null) ||
            existing.time !== (time || null) ||
            existing.timezone !== timezoneValue ||
            existing.durationMinutes !== durationMinutes);

    const updated = await interviewStore.updateInterview(id, (current) => {
        const now = new Date().toISOString();

        let nextStatus = payload.status || current.status;
        // Reschedule invalidates prior reminder deliveries for the old slot
        // and returns active interviews to Scheduled when moved to a future time.
        if (scheduleActuallyChanged && !payload.status) {
            if (
                current.status === INTERVIEW_STATUSES.REMINDER_SENT ||
                current.status === INTERVIEW_STATUSES.IN_PROGRESS ||
                current.status === INTERVIEW_STATUSES.EXPIRED
            ) {
                const start = scheduledAtIso ? dayjs(scheduledAtIso) : null;
                if (start && start.isAfter(dayjs())) {
                    nextStatus = INTERVIEW_STATUSES.SCHEDULED;
                }
            }
        }

        const nextReminders = scheduleActuallyChanged
            ? emptyReminders()
            : normalizeReminders(current.reminders);
        const reminderTimestamps = computeReminderTimestamps(scheduledAtIso);
        const nextJobRole =
            payload.jobRole !== undefined || payload.role !== undefined
                ? resolveJobRoleFromPayload(payload)
                : current.jobRole || resolveJobRoleFromPayload({
                    jobDescription:
                        payload.jobDescription !== undefined
                            ? payload.jobDescription
                            : current.jobDescription,
                });

        if (scheduleActuallyChanged) {
            console.log("[Interview] Reminder scheduled (reschedule)", {
                id: current.id,
                scheduledTimestamp: scheduledAtIso,
                reminderTimestamp: resolvePrimaryReminderTimestamp(reminderTimestamps),
                reminderTimestamps,
            });
        }

        return {
            ...current,
            candidateName,
            candidateEmail: candidateEmail.toLowerCase(),
            jobRole: nextJobRole,
            currentCompany:
                payload.currentCompany !== undefined
                    ? normalizeString(payload.currentCompany) || null
                    : current.currentCompany ??
                      resolveCurrentCompanyFromPayload({
                          resumeSummary:
                              payload.resumeSummary !== undefined
                                  ? payload.resumeSummary
                                  : payload.analysis !== undefined
                                    ? payload.analysis
                                    : current.resumeSummary,
                      }),
            interviewer:
                payload.interviewer !== undefined
                    ? normalizeString(payload.interviewer) || null
                    : current.interviewer || null,
            date: date || null,
            time: time || null,
            interviewDate: date || null,
            interviewTime: time || null,
            timezone: timezoneValue,
            durationMinutes,
            scheduledAt: scheduledAtIso,
            scheduledTimestamp: scheduledAtIso,
            expiresAt: scheduleActuallyChanged
                ? computeExpiresAt(scheduledAtIso)
                : current.expiresAt || computeExpiresAt(scheduledAtIso),
            reminderTimestamps,
            reminderTimestamp: resolvePrimaryReminderTimestamp(reminderTimestamps),
            meetingLink: payload.meetingLink !== undefined
                ? (normalizeMeetingLink(
                      sanitizeHttpUrl(payload.meetingLink) || current.meetingLink,
                      current.id
                  ))
                : normalizeMeetingLink(current.meetingLink, current.id),
            status: nextStatus,
            reminders: nextReminders,
            reminderSent: scheduleActuallyChanged
                ? false
                : current.reminderSent === true ||
                  nextReminders.sent24h ||
                  nextReminders.sent1h ||
                  nextReminders.sent30m ||
                  nextReminders.sent10m,
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
            // Artifact paths / evaluation / result are set only by completion & evaluation
            // services (interviewStore), never by client PATCH — prevents path injection.
            transcriptId: current.transcriptId || null,
            transcriptPath: current.transcriptPath || null,
            recordingPath: current.recordingPath || null,
            evaluationPath: current.evaluationPath || null,
            evaluation: current.evaluation || null,
            transcriptMeta: current.transcriptMeta || null,
            result: normalizeResult(current.result),
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
        "30m": "sent30m",
        "10m": "sent10m",
    };
    const field = keyMap[reminderKey];
    if (!field) return null;

    return enrichInterview(
        await interviewStore.updateInterview(id, (current) => {
            const reminders = normalizeReminders(current.reminders);
            reminders[field] = true;
            const nextStatus =
                current.status === INTERVIEW_STATUSES.SCHEDULED
                    ? INTERVIEW_STATUSES.REMINDER_SENT
                    : current.status;
            console.log("[Interview] Database updated — reminderSent", {
                id: current.id,
                reminderKey,
                field,
                reminders,
            });
            return {
                ...current,
                reminders,
                reminderSent: true,
                status: nextStatus,
                updatedAt: new Date().toISOString(),
            };
        })
    );
}

async function getInterviewStats() {
    const { getInterviewStats: loadStats } = require("./interviewResultService");
    return loadStats();
}

async function getCandidateRanking(options = {}) {
    const interviews = await interviewStore.getAllInterviews();
    const { buildCandidateRanking } = require("./interviewResultService");
    return buildCandidateRanking(interviews, options);
}

async function compareCandidates(ids = []) {
    const interviews = await interviewStore.getAllInterviews();
    const { buildCandidateCompare } = require("./interviewResultService");
    return buildCandidateCompare(interviews, ids);
}

async function attachHmsRoom(interview) {
    if (!interview?.id) return interview;
    if (interview.hmsRoomId) return interview;

    const hms = require("./hmsTokenService");
    if (!hms.isHmsConfigured()) {
        console.warn("[100MS] Credentials missing — interview created without a live room.");
        return interview;
    }

    try {
        const room = await hms.createInterviewRoom({
            interviewId: interview.id,
            durationMinutes: interview.durationMinutes,
        });
        const updated = await interviewStore.updateInterview(interview.id, (current) => ({
            ...current,
            hmsRoomId: room.roomId,
            hmsRoomName: room.roomName,
            interviewDetails: {
                ...normalizeInterviewDetails(current.interviewDetails),
                roomId: room.roomId,
            },
            updatedAt: new Date().toISOString(),
        }));
        return updated || interview;
    } catch (err) {
        console.error("[100MS] Interview room/session create failed:", err.message);
        return interview;
    }
}

async function ensureInterviewRoom(interview) {
    if (interview?.hmsRoomId) {
        return {
            roomId: interview.hmsRoomId,
            roomName: interview.hmsRoomName || null,
        };
    }
    const attached = await attachHmsRoom(interview);
    if (attached?.hmsRoomId) {
        return {
            roomId: attached.hmsRoomId,
            roomName: attached.hmsRoomName || null,
        };
    }
    const hms = require("./hmsTokenService");
    const legacy = hms.getConfiguredRoomId();
    if (legacy) {
        return { roomId: legacy, roomName: null };
    }
    throw createHttpError(
        "The live interview room is unavailable. Please try again shortly.",
        503
    );
}

function toCandidateInterviewPayload(interview, questions) {
    return {
        id: interview.id,
        candidateName: interview.candidateName,
        candidateEmail: interview.candidateEmail,
        jobRole: interview.jobRole,
        date: interview.date,
        time: interview.time,
        timezone: interview.timezone,
        durationMinutes: interview.durationMinutes,
        sessionCapMinutes: interview.sessionCapMinutes,
        scheduledAt: interview.scheduledAt,
        expiresAt: interview.expiresAt,
        status: interview.status,
        joinState: interview.joinState,
        questions: (interview.questions && interview.questions.length
            ? interview.questions
            : questions) || [],
        interviewJson: interview.interviewJson || null,
        interviewDetails: interview.interviewDetails || emptyInterviewDetails(),
        meetingLink: interview.meetingLink,
    };
}

function assertJoinableInterview(interview, { forCandidate = false } = {}) {
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }
    if (interview.status === INTERVIEW_STATUSES.CANCELLED) {
        throw createHttpError("This interview cannot be joined.", 403);
    }
    if (POST_COMPLETION_STATUSES.includes(interview.status)) {
        throw createHttpError("This interview has already been completed.", 403);
    }
    if (forCandidate && interview.linkExpired) {
        const err = createHttpError("Link Expired", 403);
        err.code = "LINK_EXPIRED";
        throw err;
    }
}

/**
 * Issue a 100ms auth token for the candidate interview room.
 * Always maps to the configured student role. Never trusts a client-supplied role.
 */
async function issueCandidateRoomToken(id) {
    const interview = await getInterview(id);
    assertJoinableInterview(interview, { forCandidate: true });

    const questions = extractInterviewQuestions(interview);
    const now = new Date().toISOString();
    const hms = require("./hmsTokenService");

    let token = null;
    let roomId = null;
    let hmsError = null;
    let hmsRole = null;

    try {
        const room = await ensureInterviewRoom(interview);
        hmsRole = hms.getHmsRoleForAppRole(hms.APP_ROLES.STUDENT);
        const tokenResult = await hms.generateAuthToken({
            userId: interview.candidateId || interview.id,
            userName: interview.candidateName,
            role: hmsRole,
            roomId: room.roomId,
        });
        token = tokenResult.token || null;
        roomId = tokenResult.roomId || room.roomId;
    } catch (err) {
        hmsError = err?.message || "Unable to join the live audio room.";
        console.warn("[100MS] Candidate token issue failed:", hmsError);
    }

    await interviewStore.updateInterview(id, (current) => {
        const details = normalizeInterviewDetails(current.interviewDetails);
        return {
            ...current,
            meetingLink: normalizeMeetingLink(current.meetingLink, current.id),
            hmsRoomId: roomId || current.hmsRoomId || details.roomId,
            interviewDetails: {
                ...details,
                startedAt: details.startedAt || now,
                roomId: roomId || details.roomId,
            },
            status:
                current.status === INTERVIEW_STATUSES.SCHEDULED ||
                current.status === INTERVIEW_STATUSES.REMINDER_SENT
                    ? INTERVIEW_STATUSES.IN_PROGRESS
                    : current.status,
            updatedAt: now,
        };
    });

    const refreshed = await getInterview(id);
    return {
        token,
        roomId,
        role: hms.APP_ROLES.STUDENT,
        candidateName: refreshed.candidateName,
        interview: toCandidateInterviewPayload(refreshed, questions),
        questions: refreshed.questions || questions,
        hmsError,
    };
}

/**
 * Recruiter/admin token. Requires the existing API-key gate on the route.
 * joinAs is an application role (interviewer | spectator), never a raw 100ms role.
 */
async function issueRecruiterRoomToken(id, payload = {}) {
    const interview = await getInterview(id);
    assertJoinableInterview(interview);

    const hms = require("./hmsTokenService");
    const appRole = hms.resolveAppRoleFromJoinAs(payload.joinAs || payload.role);
    if (appRole === hms.APP_ROLES.STUDENT) {
        throw createHttpError("Recruiters cannot join as the candidate.", 403);
    }

    const room = await ensureInterviewRoom(interview);
    const hmsRole = hms.getHmsRoleForAppRole(appRole);
    const tokenResult = await hms.generateAuthToken({
        userId: `recruiter-${interview.id}`.slice(0, 64),
        userName: interview.interviewer || "Interviewer",
        role: hmsRole,
        roomId: room.roomId,
    });

    const now = new Date().toISOString();
    await interviewStore.updateInterview(id, (current) => ({
        ...current,
        hmsRoomId: tokenResult.roomId || current.hmsRoomId,
        status:
            current.status === INTERVIEW_STATUSES.SCHEDULED ||
            current.status === INTERVIEW_STATUSES.REMINDER_SENT
                ? INTERVIEW_STATUSES.IN_PROGRESS
                : current.status,
        updatedAt: now,
    }));

    const refreshed = await getInterview(id);
    return {
        token: tokenResult.token,
        roomId: tokenResult.roomId,
        role: appRole,
        interview: {
            id: refreshed.id,
            candidateName: refreshed.candidateName,
            jobRole: refreshed.jobRole,
            date: refreshed.date,
            time: refreshed.time,
            timezone: refreshed.timezone,
            durationMinutes: refreshed.durationMinutes,
            status: refreshed.status,
            questions: refreshed.questions || extractInterviewQuestions(refreshed),
            joinState: refreshed.joinState,
        },
    };
}

function eventAlreadyProcessed(interview, eventId) {
    const ids = Array.isArray(interview?.hmsProcessedEventIds)
        ? interview.hmsProcessedEventIds
        : [];
    return eventId && ids.includes(eventId);
}

function rememberEventId(current, eventId) {
    const ids = Array.isArray(current.hmsProcessedEventIds)
        ? current.hmsProcessedEventIds.slice()
        : [];
    if (eventId && !ids.includes(eventId)) {
        ids.push(eventId);
    }
    return ids.slice(-120);
}

async function findInterviewForHmsEvent(parsed) {
    const interviews = await interviewStore.getAllInterviews();
    if (parsed.roomId) {
        const byRoom = interviews.find((item) => item.hmsRoomId === parsed.roomId);
        if (byRoom) return byRoom;
    }
    if (parsed.sessionId) {
        const bySession = interviews.find((item) => item.hmsSessionId === parsed.sessionId);
        if (bySession) return bySession;
    }
    const hms = require("./hmsTokenService");
    const fromName = hms.interviewIdFromRoomName(parsed.roomName);
    if (fromName) {
        return interviews.find((item) => item.id === fromName) || null;
    }
    return null;
}

function buildLinesFromCandidateAnswers(interview) {
    const details = normalizeInterviewDetails(interview?.interviewDetails);
    const lines = [];
    for (const answer of details.answers) {
        const question = String(answer.question || "").trim();
        const spoken = String(answer.transcript || "").trim();
        if (question) {
            lines.push({
                timestamp: answer.answeredAt || undefined,
                speaker: "AI",
                text: question,
            });
        }
        if (spoken) {
            lines.push({
                timestamp: answer.answeredAt || undefined,
                speaker: "Candidate",
                text: spoken,
            });
        }
    }
    return lines;
}

async function queueInterviewFinalization(interviewId, payload = {}) {
    setImmediate(() => {
        Promise.resolve()
            .then(async () => {
                const { tryFinalizeInterview } = require("./interviewCompletionService");
                await tryFinalizeInterview(interviewId, payload);
            })
            .catch((err) => {
                console.error("[100MS] Interview completion follow-up failed:", err.message);
            });
    });
}

/**
 * Idempotent 100ms webhook processor. Updates the existing interview record only.
 */
async function processHmsWebhook(rawEvent) {
    const hms = require("./hmsTokenService");
    const parsed = hms.parseWebhookEvent(rawEvent);
    if (!parsed.type) {
        return { ignored: true, reason: "missing_event_type" };
    }

    const interview = await findInterviewForHmsEvent(parsed);
    if (!interview) {
        console.warn("[100MS] Webhook processed — no matching interview", {
            type: parsed.type,
            roomId: parsed.roomId || null,
        });
        return { ignored: true, reason: "interview_not_found" };
    }

    if (eventAlreadyProcessed(interview, parsed.eventId)) {
        console.log("[100MS] Webhook processed", {
            type: parsed.type,
            interviewId: interview.id,
            duplicate: true,
        });
        return { ok: true, duplicate: true, interviewId: interview.id };
    }

    const now = new Date().toISOString();
    const appRole = hms.resolveAppRoleFromHmsRole(parsed.peerRole);
    const type = parsed.type.toLowerCase();

    await interviewStore.updateInterview(interview.id, (current) => {
        const next = {
            ...current,
            hmsProcessedEventIds: rememberEventId(current, parsed.eventId),
            hmsLastEventType: parsed.type,
            hmsRoomId: parsed.roomId || current.hmsRoomId,
            hmsRoomName: parsed.roomName || current.hmsRoomName,
            hmsSessionId: parsed.sessionId || current.hmsSessionId,
            updatedAt: now,
        };

        if (type.includes("peer.join") || type.includes("peer.joined")) {
            if (appRole === hms.APP_ROLES.STUDENT) {
                next.hmsCandidateJoinedAt = next.hmsCandidateJoinedAt || parsed.timestamp || now;
                console.log("[100MS] Candidate joined", { interviewId: current.id });
            } else if (
                appRole === hms.APP_ROLES.INTERVIEWER ||
                appRole === hms.APP_ROLES.ADMIN
            ) {
                next.hmsInterviewerJoinedAt = next.hmsInterviewerJoinedAt || parsed.timestamp || now;
                console.log("[100MS] Interviewer joined", { interviewId: current.id });
            }
            if (
                current.status === INTERVIEW_STATUSES.SCHEDULED ||
                current.status === INTERVIEW_STATUSES.REMINDER_SENT
            ) {
                next.status = INTERVIEW_STATUSES.IN_PROGRESS;
            }
        }

        if (type.includes("session.open") || type.includes("session.started")) {
            next.hmsStartedAt = next.hmsStartedAt || parsed.timestamp || now;
            if (!POST_COMPLETION_STATUSES.includes(current.status)) {
                next.status = INTERVIEW_STATUSES.IN_PROGRESS;
            }
            console.log("[100MS] Interview started", { interviewId: current.id });
        }

        if (type.includes("session.close") || type.includes("session.ended")) {
            next.hmsEndedAt = parsed.timestamp || now;
            if (!POST_COMPLETION_STATUSES.includes(current.status)) {
                next.status = INTERVIEW_STATUSES.COMPLETED;
            }
            console.log("[100MS] Interview completed", { interviewId: current.id });
        }

        if (type.includes("recording") && type.includes("fail")) {
            next.recordingStatus = "unavailable";
        }

        if (type.includes("recording") && (type.includes("success") || type.includes("ready"))) {
            next.hmsRecordingId = parsed.recordingId || current.hmsRecordingId;
            next.recordingStatus = current.recordingPath ? "available" : "pending";
        }

        return next;
    });

    if (type.includes("recording") && (type.includes("success") || type.includes("ready"))) {
        await persistHmsRecording(interview.id, parsed).catch((err) => {
            console.error("[100MS] Recording persist failed:", err.message);
        });
    }

    if (type.includes("transcription") && (type.includes("success") || type.includes("ready"))) {
        const lines = hms.extractTranscriptLines(parsed.transcriptLines || [], {
            candidateUserId: interview.candidateId || interview.id,
        });
        if (lines.length) {
            await queueInterviewFinalization(interview.id, {
                lines,
                provider: "100ms",
                audioFilePath: interview.recordingPath || null,
            });
        }
    }

    if (type.includes("session.close") || type.includes("session.ended")) {
        await finalizeAfterHmsSession(interview.id, parsed);
    }

    console.log("[100MS] Webhook processed", {
        type: parsed.type,
        interviewId: interview.id,
    });
    return { ok: true, interviewId: interview.id, type: parsed.type };
}

async function persistHmsRecording(interviewId, parsed) {
    const hms = require("./hmsTokenService");
    let sourceUrl = parsed.recordingUrl;
    if (!sourceUrl) {
        const assets = await hms.listRecordingAssets({
            sessionId: parsed.sessionId,
            roomId: parsed.roomId,
        });
        const asset = assets.find((item) => hms.pickRecordingUrl(item));
        sourceUrl = hms.pickRecordingUrl(asset);
        if (asset?.id) {
            parsed.recordingId = asset.id;
        }
    }
    if (!sourceUrl) {
        await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            recordingStatus: current.recordingPath ? "available" : "unavailable",
            updatedAt: new Date().toISOString(),
        }));
        return null;
    }

    const saved = await hms.downloadRecordingToDisk(interviewId, sourceUrl);
    if (!saved) {
        await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            recordingStatus: "unavailable",
            updatedAt: new Date().toISOString(),
        }));
        return null;
    }

    await interviewStore.updateInterview(interviewId, (current) => ({
        ...current,
        hmsRecordingId: parsed.recordingId || current.hmsRecordingId,
        recordingPath: saved.relativePath,
        recordingStatus: "available",
        updatedAt: new Date().toISOString(),
    }));
    console.log("[100MS] Recording available", { interviewId });
    return saved;
}

async function finalizeAfterHmsSession(interviewId, parsed) {
    const interview = await interviewStore.getInterviewById(interviewId);
    if (!interview) return;

    const hms = require("./hmsTokenService");
    let lines = hms.extractTranscriptLines(parsed.transcriptLines || [], {
        candidateUserId: interview.candidateId || interview.id,
    });
    if (!lines.length) {
        lines = buildLinesFromCandidateAnswers(interview);
    }

    if (!lines.length) {
        await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            transcriptStatus: current.transcriptId ? "available" : "unavailable",
            recordingStatus:
                current.recordingPath
                    ? "available"
                    : current.recordingStatus || "unavailable",
            updatedAt: new Date().toISOString(),
        }));
        return;
    }

    await queueInterviewFinalization(interviewId, {
        lines,
        provider: "100ms",
        audioFilePath:
            interview.recordingPath && !String(interview.recordingPath).startsWith("/api/")
                ? interview.recordingPath
                : null,
    });
}

/**
 * Persist per-question candidate answers / speech transcripts under interviewDetails.
 */
async function saveCandidateAnswers(id, payload = {}) {
    const interview = await interviewStore.getInterviewById(id);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }

    const now = new Date().toISOString();
    const details = normalizeInterviewDetails(interview.interviewDetails);
    const incomingAnswers = Array.isArray(payload.answers)
        ? payload.answers
        : payload.answer
          ? [payload.answer]
          : [];

    const markComplete = payload.completed === true || payload.finish === true;

    if (
        incomingAnswers.length === 0 &&
        payload.questionNo == null &&
        !payload.transcript &&
        !markComplete
    ) {
        throw createHttpError("Provide answers[] or a single answer with transcript.", 400);
    }

    const normalizedIncoming =
        incomingAnswers.length > 0
            ? incomingAnswers
            : payload.questionNo != null || payload.transcript
              ? [
                    {
                        questionNo: payload.questionNo,
                        question: payload.question,
                        transcript: payload.transcript || payload.text || "",
                        audioDurationSeconds: payload.audioDurationSeconds,
                    },
                ]
              : [];

    for (const raw of normalizedIncoming) {
        const questionNo = Number(raw.questionNo);
        const transcript =
            typeof raw.transcript === "string"
                ? raw.transcript.trim()
                : typeof raw.text === "string"
                  ? raw.text.trim()
                  : "";
        if (!Number.isFinite(questionNo) || questionNo < 1) {
            throw createHttpError("Each answer requires a valid questionNo.", 400);
        }

        const entry = {
            questionNo,
            question:
                typeof raw.question === "string" && raw.question.trim()
                    ? raw.question.trim()
                    : null,
            transcript,
            audioDurationSeconds:
                raw.audioDurationSeconds != null && Number.isFinite(Number(raw.audioDurationSeconds))
                    ? Number(raw.audioDurationSeconds)
                    : null,
            answeredAt: raw.answeredAt || now,
        };

        const existingIdx = details.answers.findIndex((a) => a.questionNo === questionNo);
        if (existingIdx >= 0) {
            details.answers[existingIdx] = {
                ...details.answers[existingIdx],
                ...entry,
                transcript: entry.transcript || details.answers[existingIdx].transcript,
            };
        } else {
            details.answers.push(entry);
        }
    }

    details.answers.sort((a, b) => a.questionNo - b.questionNo);

    if (markComplete) {
        details.completedAt = now;
    }

    const updated = await interviewStore.updateInterview(id, (current) => ({
        ...current,
        interviewDetails: details,
        status: markComplete ? INTERVIEW_STATUSES.COMPLETED : current.status,
        updatedAt: now,
    }));

    if (markComplete) {
        const lines = buildLinesFromCandidateAnswers(updated);
        if (lines.length) {
            queueInterviewFinalization(id, {
                lines,
                provider: "live-session",
            });
        } else {
            await interviewStore.updateInterview(id, (current) => ({
                ...current,
                transcriptStatus: current.transcriptId ? "available" : "unavailable",
                updatedAt: new Date().toISOString(),
            }));
        }
    }

    return enrichInterview(updated);
}

/**
 * Extend the candidate meeting link by +24 hours if it has not expired yet.
 */
async function extendInterviewLink(id) {
    const interview = await interviewStore.getInterviewById(id);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }

    const expiresAt = resolveExpiresAt(interview);
    if (!expiresAt) {
        throw createHttpError("Interview has no expiration to extend.", 400);
    }
    if (dayjs().isAfter(dayjs(expiresAt))) {
        throw createHttpError("Cannot extend an expired link", 400);
    }

    const nextExpiresAt = dayjs(expiresAt).add(LINK_EXTEND_HOURS, "hour").toISOString();
    const updated = await interviewStore.updateInterview(id, (current) => ({
        ...current,
        expiresAt: nextExpiresAt,
        updatedAt: new Date().toISOString(),
    }));

    return enrichInterview(updated);
}

module.exports = {
    INTERVIEW_STATUSES,
    INTERVIEW_RESULTS,
    POST_COMPLETION_STATUSES,
    DEFAULT_DURATION_MINUTES,
    MAX_INTERVIEW_QUESTIONS,
    MAX_SESSION_MINUTES,
    LINK_EXPIRY_HOURS,
    LINK_EXTEND_HOURS,
    REMINDER_OFFSET_MINUTES,
    createInterview,
    listInterviews,
    getInterview,
    updateInterview,
    removeInterview,
    markInvitationSent,
    markReminderSent,
    enrichInterview,
    buildMeetingLink,
    normalizeMeetingLink,
    extractInterviewQuestions,
    parseInterviewDateTime,
    computeReminderTimestamps,
    computeJoinState,
    applyLifecycleTransitions,
    isPostCompletion,
    getInterviewStats,
    getCandidateRanking,
    compareCandidates,
    issueCandidateRoomToken,
    issueRecruiterRoomToken,
    processHmsWebhook,
    saveCandidateAnswers,
    extendInterviewLink,
    computeExpiresAt,
    sessionCapMinutes,
};
