const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const interviewStore = require("./interviewStore");
const interviewService = require("./interviewService");
const { sendInterviewReminder } = require("./emailService");
const {
    INTERVIEW_STATUSES,
    ACTIVE_SCHEDULE_STATUSES,
} = require("../models/interviewStatuses");

/**
 * Reminder offsets are configurable (minutes before scheduledAt).
 * Default production windows: 24h / 1h / 30m / 10m.
 * Local testing example: REMINDER_WINDOWS=24h:4,1h:2,30m:1,10m:1
 *
 * All comparisons use absolute UTC instants derived from ISO scheduledAt
 * (same timezone model as interview scheduling).
 */
const KEY_FIELD_MAP = Object.freeze({
    "24h": "sent24h",
    "1h": "sent1h",
    "30m": "sent30m",
    "10m": "sent10m",
});

const DEFAULT_WINDOWS_SPEC = "24h:1440,1h:60,30m:30,10m:10";
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000;

let reminderInterval = null;
let bootTimeout = null;
let isProcessing = false;

function parseCheckIntervalMs() {
    const raw = Number(process.env.REMINDER_CHECK_INTERVAL_MS);
    if (Number.isFinite(raw) && raw >= 5000) {
        return Math.floor(raw);
    }
    return DEFAULT_CHECK_INTERVAL_MS;
}

function parseWindowsSpec(spec) {
    const windows = [];

    for (const part of String(spec || "").split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        const [keyRaw, minutesRaw] = trimmed.split(":");
        const key = (keyRaw || "").trim();
        const minutesBefore = Number(minutesRaw);
        const field = KEY_FIELD_MAP[key];

        if (!field || !Number.isFinite(minutesBefore) || minutesBefore <= 0) {
            console.warn(
                `[Reminder] Skipping invalid window spec "${trimmed}". Expected e.g. 24h:1440`
            );
            continue;
        }

        windows.push({ key, field, minutesBefore: Math.floor(minutesBefore) });
    }

    // Process earliest-before-interview first (24h → 1h → 30m → 10m)
    windows.sort((a, b) => b.minutesBefore - a.minutesBefore);
    return windows;
}

function loadWindows() {
    const windows = parseWindowsSpec(process.env.REMINDER_WINDOWS || DEFAULT_WINDOWS_SPEC);
    if (windows.length === 0) {
        console.warn("[Reminder] No valid REMINDER_WINDOWS; falling back to defaults.");
        return parseWindowsSpec(DEFAULT_WINDOWS_SPEC);
    }
    return windows;
}

/**
 * Prefer scheduledAt; fall back to scheduledTimestamp (same ISO UTC instant).
 */
function resolveScheduledAt(interview) {
    return interview?.scheduledAt || interview?.scheduledTimestamp || null;
}

/**
 * Why a tier is not due. Returns null when the tier IS due.
 *
 * Short-notice uses minute-ceil of the true lead time so minute-granular UI
 * picks ("1 hour from now" at :15:30 → 11:15) still qualify for that tier.
 * Truncating with dayjs.diff(..., "minute") previously treated 59m59s as 59
 * and skipped every matching window — leaving pending=0 until a nearer tier.
 */
function getReminderSkipReason(interview, minutesBefore, nextMinutesBefore = 0) {
    const scheduledRaw = resolveScheduledAt(interview);
    if (!scheduledRaw) {
        return "missing_scheduledAt";
    }

    const scheduledAt = dayjs.utc(scheduledRaw);
    if (!scheduledAt.isValid()) {
        return "invalid_scheduledAt";
    }

    const now = dayjs.utc();
    if (!now.isBefore(scheduledAt)) {
        return "interview_already_started";
    }

    // Short-notice first (before due/expiry) so logs show why far tiers never apply
    // for interviews booked closer than the window (e.g. 12m lead → skip 24h/1h/30m).
    const createdRaw = interview.createdAt || interview.updatedAt;
    if (createdRaw) {
        const createdAt = dayjs.utc(createdRaw);
        if (createdAt.isValid()) {
            const leadSeconds = scheduledAt.diff(createdAt, "second");
            // Ceil to whole minutes to match HH:mm scheduling granularity.
            // Truncating with dayjs.diff(..., "minute") previously treated 9m40s as 9
            // and skipped the matching 10m tier forever (pending stayed 0).
            const leadTimeMinutes = Math.max(0, Math.ceil(leadSeconds / 60));
            if (leadTimeMinutes < minutesBefore) {
                return `short_notice_lead_${leadTimeMinutes}m_lt_${minutesBefore}m`;
            }
        }
    }

    const reminderTimestamp = scheduledAt.subtract(minutesBefore, "minute");
    if (now.isBefore(reminderTimestamp)) {
        return "not_yet_due";
    }

    // Expire when the next tier becomes due (prevents stale "24h"/"1h" mail near interview time).
    // Last tier (nextMinutesBefore === 0) stays eligible until scheduledAt — survives downtime.
    const expiry =
        nextMinutesBefore > 0
            ? scheduledAt.subtract(nextMinutesBefore, "minute")
            : scheduledAt;
    if (!now.isBefore(expiry)) {
        return "window_expired_next_tier_active";
    }

    return null;
}

/**
 * A reminder is due when:
 *   status is active (Scheduled / Reminder Sent / In Progress)
 *   AND the per-tier flag is false (reminderSent / reminders.sent*)
 *   AND currentTime (UTC) >= reminderTimestamp (scheduledAt - offset)
 *   AND interview has not started yet
 *
 * Catch-up eligibility (idempotent via sent flags):
 * - Due once now >= (scheduledAt - offset)
 * - Remains due until the next reminder tier starts (or interview start for the last tier)
 * - Skips tiers that never applied (short-notice booking shorter than the offset)
 * - Skips stale far-tier emails once a closer tier is already active
 *
 * @param {object} interview
 * @param {number} minutesBefore
 * @param {number} [nextMinutesBefore=0] minutesBefore of the following tier (0 = last tier)
 */
function isReminderDue(interview, minutesBefore, nextMinutesBefore = 0) {
    return getReminderSkipReason(interview, minutesBefore, nextMinutesBefore) === null;
}

function wasReminderSent(interview, field) {
    const reminders = interview.reminders || {};
    return !!reminders[field];
}

function logReminder(event, details = {}) {
    if (process.env.NODE_ENV === "production") {
        // In production, only log send/failure outcomes (skip noisy poll chatter)
        if (!/sent|failed|error|started|stopped/i.test(event)) {
            return;
        }
    }
    const payload = Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    console.log(`[Reminder] ${event}${payload}`);
}

function countByStatus(interviews) {
    const counts = {};
    for (const item of interviews) {
        const key = item.status || "(missing)";
        counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
}

/**
 * Collect pending reminder jobs for logging / processing.
 * status in active schedule statuses
 * AND per-tier not sent
 * AND now >= reminderTimestamp
 */
function collectPendingReminders(interviews, windows) {
    const pending = [];
    const skipLog = [];

    const eligible = interviews.filter((item) => {
        const scheduledAt = resolveScheduledAt(item);
        return (
            ACTIVE_SCHEDULE_STATUSES.includes(item.status) &&
            !!scheduledAt &&
            item.status !== INTERVIEW_STATUSES.CANCELLED &&
            item.status !== INTERVIEW_STATUSES.COMPLETED &&
            item.status !== INTERVIEW_STATUSES.EXPIRED
        );
    });

    const ineligible = interviews.filter((item) => !eligible.includes(item));
    for (const item of ineligible) {
        let reason = "status_not_active";
        if (!resolveScheduledAt(item)) reason = "missing_scheduledAt";
        else if (item.status === INTERVIEW_STATUSES.CANCELLED) reason = "cancelled";
        else if (item.status === INTERVIEW_STATUSES.COMPLETED) reason = "completed";
        else if (item.status === INTERVIEW_STATUSES.EXPIRED) reason = "expired";
        else if (item.status === INTERVIEW_STATUSES.DRAFT) reason = "draft";
        skipLog.push({ id: item.id, status: item.status, reason });
    }

    for (const interview of eligible) {
        // Normalize so due-checks always see scheduledAt even for legacy rows.
        if (!interview.scheduledAt && interview.scheduledTimestamp) {
            interview.scheduledAt = interview.scheduledTimestamp;
        }

        for (let i = 0; i < windows.length; i++) {
            const window = windows[i];
            const nextMinutesBefore = windows[i + 1]?.minutesBefore || 0;

            if (wasReminderSent(interview, window.field)) {
                skipLog.push({
                    id: interview.id,
                    tier: window.key,
                    reason: "already_sent",
                    recipient: interview.candidateEmail || null,
                });
                continue;
            }

            const skipReason = getReminderSkipReason(
                interview,
                window.minutesBefore,
                nextMinutesBefore
            );
            if (skipReason) {
                skipLog.push({
                    id: interview.id,
                    tier: window.key,
                    reason: skipReason,
                    scheduledAt: resolveScheduledAt(interview),
                    recipient: interview.candidateEmail || null,
                });
                continue;
            }

            pending.push({ interview, window });
        }
    }

    return { eligible, pending, skipLog };
}

async function processReminders() {
    if (isProcessing) {
        logReminder("Skipped Already Running");
        return { processed: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
    }
    isProcessing = true;

    const windows = loadWindows();
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    try {
        console.log("[Reminder] Checking pending reminders...");
        console.log(`[Reminder] Store file: ${interviewStore.STORE_FILEPATH}`);

        // Keep statuses in sync with wall-clock (Scheduled → In Progress → Expired)
        // so the reminder query and Interview Management share the same lifecycle.
        const now = dayjs();
        let interviews = await interviewStore.getAllInterviews();
        let lifecycleWrites = 0;
        for (const item of interviews) {
            const { changed } = interviewService.applyLifecycleTransitions(item, now);
            if (!changed) continue;
            await interviewStore.updateInterview(item.id, (current) => {
                const result = interviewService.applyLifecycleTransitions(current, now);
                return result.changed ? result.item : current;
            });
            lifecycleWrites += 1;
        }
        if (lifecycleWrites > 0) {
            interviews = await interviewStore.getAllInterviews();
            console.log(`[Reminder] Lifecycle synced for ${lifecycleWrites} interview(s)`);
        }

        if (interviews.length === 0) {
            console.log(
                "[Reminder] Store is empty — no scheduled interviews. " +
                    "Reminders only run after POST /api/interviews (Schedule Interview). " +
                    "Resume upload / AI interview generation does NOT create a calendar schedule."
            );
        }

        const scheduledStatusCount = interviews.filter(
            (item) => item.status === INTERVIEW_STATUSES.SCHEDULED
        ).length;
        const { eligible, pending, skipLog } = collectPendingReminders(interviews, windows);

        const summary = {
            store: interviewStore.STORE_FILEPATH,
            total: interviews.length,
            scheduledStatus: scheduledStatusCount,
            eligible: eligible.length,
            pending: pending.length,
            statusCounts: countByStatus(interviews),
            windows: windows.map((w) => `${w.key}:${w.minutesBefore}m`),
            nowUtc: dayjs.utc().toISOString(),
        };
        // Always print (not gated by NODE_ENV) — primary diagnostic line.
        console.log("[Reminder] Found pending reminders", JSON.stringify(summary));
        console.log(`[Reminder] Found ${pending.length} pending reminders`);

        if (skipLog.length > 0) {
            // Cap volume so large DBs do not flood the console every minute.
            const preview = skipLog.slice(0, 40);
            console.log(
                "[Reminder] Skip details",
                JSON.stringify({ count: skipLog.length, shown: preview.length, items: preview })
            );
        }

        // Track in-memory sent flags within this cycle to avoid double-send
        // if the same interview somehow appears twice.
        const sentThisCycle = new Set();

        for (const { interview, window } of pending) {
            processed += 1;
            const cycleKey = `${interview.id}:${window.key}`;
            const recipient = interview.candidateEmail || null;

            if (sentThisCycle.has(cycleKey) || wasReminderSent(interview, window.field)) {
                logReminder("Skipped Already Sent", {
                    id: interview.id,
                    type: window.key,
                    recipient,
                });
                skipped += 1;
                continue;
            }

            const scheduledAtIso = resolveScheduledAt(interview);
            const reminderTimestamp =
                interview.reminderTimestamps?.[window.key] ||
                dayjs.utc(scheduledAtIso).subtract(window.minutesBefore, "minute").toISOString();

            console.log(
                `[Reminder] Sending reminder for Interview ID ${interview.id} (${window.key}) → ${recipient}`
            );
            logReminder("Sending Email", {
                id: interview.id,
                type: window.key,
                recipient,
                candidateName: interview.candidateName,
                candidateEmail: recipient,
                interviewTime: `${interview.time} (${interview.timezone || "UTC"})`,
                interviewDate: interview.date,
                scheduledAt: scheduledAtIso,
                reminderTimestamp,
            });

            try {
                const result = await sendInterviewReminder(interview, window.key);

                // Only mark sent on actual delivery. Skipped (invalid email)
                // must remain retryable after the address is corrected.
                if (result?.success) {
                    await interviewService.markReminderSent(interview.id, window.key);
                    sentThisCycle.add(cycleKey);
                    // Keep local copy in sync for subsequent windows in this cycle
                    interview.reminders = {
                        ...(interview.reminders || {}),
                        [window.field]: true,
                    };
                    interview.reminderSent = true;
                    sent += 1;
                    console.log(
                        `[Reminder] Reminder sent successfully for Interview ID ${interview.id} → ${recipient}`
                    );
                    logReminder("Reminder Sent", {
                        id: interview.id,
                        type: window.key,
                        recipient,
                        messageId: result.messageId || null,
                        smtpResponse: result.response || null,
                    });
                } else {
                    failed += 1;
                    console.log(
                        `[Reminder] Reminder failed for Interview ID ${interview.id} → ${recipient}: ${result?.reason || "unknown"}`
                    );
                    logReminder("Reminder Failed", {
                        id: interview.id,
                        type: window.key,
                        recipient,
                        reason: result?.reason || "unknown",
                    });
                }
            } catch (err) {
                // Continue processing other reminders even if one fails
                failed += 1;
                console.error(
                    `[Reminder] Reminder failed for Interview ID ${interview.id} → ${recipient}: ${err.message}`
                );
                if (err.stack) console.error(err.stack);
                logReminder("Reminder Failed", {
                    id: interview.id,
                    type: window.key,
                    recipient,
                    error: err.message,
                });
            }
        }

        logReminder("Cycle Complete", { processed, sent, failed, skipped, pending: pending.length });
        return { processed, sent, failed, skipped, pending: pending.length };
    } catch (err) {
        console.error("[Reminder] Processor error:", err.message);
        if (err.stack) console.error(err.stack);
        return { processed, sent, failed, skipped, error: err.message };
    } finally {
        isProcessing = false;
    }
}

function startReminderScheduler() {
    if (reminderInterval) {
        logReminder("Scheduler Already Running");
        return;
    }

    const intervalMs = parseCheckIntervalMs();
    const windows = loadWindows();

    console.log("[Reminder] Scheduler started");
    console.log(`[Reminder] Store file: ${interviewStore.STORE_FILEPATH}`);
    logReminder("Scheduler Started", {
        intervalMs,
        store: interviewStore.STORE_FILEPATH,
        windows: windows.map((w) => `${w.key}:${w.minutesBefore}m`),
        timezoneMode: "UTC absolute (ISO scheduledAt)",
    });

    // Run once shortly after boot (catch up anything missed while down)
    bootTimeout = setTimeout(() => {
        processReminders().catch((err) => {
            console.error("[Reminder] Boot cycle error:", err.message);
            if (err.stack) console.error(err.stack);
        });
    }, 5000);

    reminderInterval = setInterval(() => {
        processReminders().catch((err) => {
            console.error("[Reminder] Interval cycle error:", err.message);
            if (err.stack) console.error(err.stack);
        });
    }, intervalMs);

    if (typeof reminderInterval.unref === "function") {
        reminderInterval.unref();
    }
    if (bootTimeout && typeof bootTimeout.unref === "function") {
        bootTimeout.unref();
    }
}

function stopReminderScheduler() {
    if (bootTimeout) {
        clearTimeout(bootTimeout);
        bootTimeout = null;
    }
    if (reminderInterval) {
        clearInterval(reminderInterval);
        reminderInterval = null;
        logReminder("Scheduler Stopped");
    }
}

module.exports = {
    startReminderScheduler,
    stopReminderScheduler,
    processReminders,
    isReminderDue,
    getReminderSkipReason,
    resolveScheduledAt,
    loadWindows,
    collectPendingReminders,
};
