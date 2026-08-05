/**
 * Canonical interview lifecycle statuses for Phase 2 scheduling.
 */
const INTERVIEW_STATUSES = Object.freeze({
    DRAFT: "Draft",
    SCHEDULED: "Scheduled",
    REMINDER_SENT: "Reminder Sent",
    IN_PROGRESS: "In Progress",
    COMPLETED: "Completed",
    CANCELLED: "Cancelled",
    EXPIRED: "Expired",
});

const ACTIVE_SCHEDULE_STATUSES = Object.freeze([
    INTERVIEW_STATUSES.SCHEDULED,
    INTERVIEW_STATUSES.REMINDER_SENT,
    INTERVIEW_STATUSES.IN_PROGRESS,
]);

const ALL_STATUSES = Object.freeze(Object.values(INTERVIEW_STATUSES));

module.exports = {
    INTERVIEW_STATUSES,
    ACTIVE_SCHEDULE_STATUSES,
    ALL_STATUSES,
};
