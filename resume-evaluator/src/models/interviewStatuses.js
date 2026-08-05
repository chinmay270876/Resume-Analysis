/**
 * Canonical interview lifecycle statuses for Phase 2 scheduling
 * and post-interview transcript / evaluation pipeline.
 */
const INTERVIEW_STATUSES = Object.freeze({
    DRAFT: "Draft",
    SCHEDULED: "Scheduled",
    REMINDER_SENT: "Reminder Sent",
    IN_PROGRESS: "In Progress",
    COMPLETED: "Completed",
    TRANSCRIPT_GENERATED: "Transcript Generated",
    EVALUATION_GENERATED: "Evaluation Generated",
    RESULT_GENERATED: "Result Generated",
    CANCELLED: "Cancelled",
    EXPIRED: "Expired",
});

/** Final hiring outcome — independent of lifecycle status. */
const INTERVIEW_RESULTS = Object.freeze({
    PENDING: "Pending",
    SELECTED: "Selected",
    REJECTED: "Rejected",
});

/** Transcript evaluation pipeline status (stored on transcript record). */
const EVALUATION_STATUSES = Object.freeze({
    PENDING: "Pending",
    GENERATED: "Generated",
    FAILED: "Failed",
});

const ACTIVE_SCHEDULE_STATUSES = Object.freeze([
    INTERVIEW_STATUSES.SCHEDULED,
    INTERVIEW_STATUSES.REMINDER_SENT,
    INTERVIEW_STATUSES.IN_PROGRESS,
]);

/** Statuses reached after a live Voice AI interview finishes. */
const POST_COMPLETION_STATUSES = Object.freeze([
    INTERVIEW_STATUSES.COMPLETED,
    INTERVIEW_STATUSES.TRANSCRIPT_GENERATED,
    INTERVIEW_STATUSES.EVALUATION_GENERATED,
    INTERVIEW_STATUSES.RESULT_GENERATED,
]);

const ALL_STATUSES = Object.freeze(Object.values(INTERVIEW_STATUSES));
const ALL_RESULTS = Object.freeze(Object.values(INTERVIEW_RESULTS));
const ALL_EVALUATION_STATUSES = Object.freeze(Object.values(EVALUATION_STATUSES));

module.exports = {
    INTERVIEW_STATUSES,
    INTERVIEW_RESULTS,
    EVALUATION_STATUSES,
    ACTIVE_SCHEDULE_STATUSES,
    POST_COMPLETION_STATUSES,
    ALL_STATUSES,
    ALL_RESULTS,
    ALL_EVALUATION_STATUSES,
};
