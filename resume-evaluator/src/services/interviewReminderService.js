const dayjs = require("dayjs");
const interviewStore = require("./interviewStore");
const interviewService = require("./interviewService");
const { sendInterviewReminder } = require("./emailService");
const {
    INTERVIEW_STATUSES,
    ACTIVE_SCHEDULE_STATUSES,
} = require("../models/interviewStatuses");

const CHECK_INTERVAL_MS = 60 * 1000; // every minute
const WINDOWS = [
    { key: "24h", field: "sent24h", minutesBefore: 24 * 60, windowMinutes: 30 },
    { key: "1h", field: "sent1h", minutesBefore: 60, windowMinutes: 10 },
    { key: "10m", field: "sent10m", minutesBefore: 10, windowMinutes: 5 },
];

let reminderInterval = null;
let isProcessing = false;

function isWithinReminderWindow(scheduledAt, minutesBefore, windowMinutes) {
    const start = dayjs(scheduledAt).subtract(minutesBefore, "minute");
    const end = start.add(windowMinutes, "minute");
    const now = dayjs();
    return (now.isAfter(start) || now.isSame(start)) && now.isBefore(end);
}

async function processReminders() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const interviews = await interviewStore.getAllInterviews();
        const eligible = interviews.filter(
            (item) =>
                ACTIVE_SCHEDULE_STATUSES.includes(item.status) &&
                item.scheduledAt &&
                item.status !== INTERVIEW_STATUSES.CANCELLED &&
                item.status !== INTERVIEW_STATUSES.COMPLETED &&
                item.status !== INTERVIEW_STATUSES.EXPIRED
        );

        for (const interview of eligible) {
            const reminders = interview.reminders || {};

            for (const window of WINDOWS) {
                if (reminders[window.field]) continue;

                if (
                    isWithinReminderWindow(
                        interview.scheduledAt,
                        window.minutesBefore,
                        window.windowMinutes
                    )
                ) {
                    try {
                        const result = await sendInterviewReminder(interview, window.key);
                        // Only mark sent on actual delivery. Skipped (invalid email)
                        // must remain retryable after the address is corrected.
                        if (result?.success) {
                            await interviewService.markReminderSent(interview.id, window.key);
                        }
                    } catch (err) {
                        console.error(
                            `⚠️ Failed to send ${window.key} reminder for interview ${interview.id}:`,
                            err.message
                        );
                    }
                }
            }
        }
    } catch (err) {
        console.error("⚠️ Reminder processor error:", err.message);
    } finally {
        isProcessing = false;
    }
}

function startReminderScheduler() {
    if (reminderInterval) return;

    console.log("⏰ Interview reminder scheduler started (interval: 60s)");
    // Run once shortly after boot, then on interval
    setTimeout(() => {
        processReminders().catch(() => {});
    }, 5000);

    reminderInterval = setInterval(() => {
        processReminders().catch(() => {});
    }, CHECK_INTERVAL_MS);

    if (typeof reminderInterval.unref === "function") {
        reminderInterval.unref();
    }
}

function stopReminderScheduler() {
    if (reminderInterval) {
        clearInterval(reminderInterval);
        reminderInterval = null;
        console.log("⏰ Interview reminder scheduler stopped");
    }
}

module.exports = {
    startReminderScheduler,
    stopReminderScheduler,
    processReminders,
};
