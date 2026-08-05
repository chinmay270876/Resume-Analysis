const interviewService = require("../services/interviewService");
const { sendScheduledInterviewInvite } = require("../services/emailService");
const { INTERVIEW_STATUSES } = require("../models/interviewStatuses");

/**
 * POST /api/interviews
 * Create a scheduled (or draft) interview and optionally send the invitation email.
 */
exports.createInterview = async (req, res, next) => {
    try {
        const interview = await interviewService.createInterview(req.body || {});

        let emailResult = null;
        if (
            interview.status === INTERVIEW_STATUSES.SCHEDULED ||
            interview.status === INTERVIEW_STATUSES.REMINDER_SENT
        ) {
            try {
                emailResult = await sendScheduledInterviewInvite(interview);
                if (emailResult?.success) {
                    await interviewService.markInvitationSent(interview.id);
                    interview.invitationSent = true;
                    interview.invitationSentAt = new Date().toISOString();
                }
            } catch (emailErr) {
                console.error("⚠️ Invitation email failed (interview still created):", emailErr.message);
                emailResult = { success: false, error: emailErr.message };
            }
        }

        return res.status(201).json({
            success: true,
            interview: await interviewService.getInterview(interview.id),
            email: emailResult,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews
 * Query: filter=upcoming|today|completed|cancelled, status=...
 */
exports.listInterviews = async (req, res, next) => {
    try {
        const interviews = await interviewService.listInterviews({
            filter: req.query.filter,
            status: req.query.status,
        });

        return res.status(200).json({
            success: true,
            count: interviews.length,
            interviews,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/:id
 */
exports.getInterview = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);
        return res.status(200).json({
            success: true,
            interview,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PATCH /api/interviews/:id
 */
exports.updateInterview = async (req, res, next) => {
    try {
        const previous = await interviewService.getInterview(req.params.id);
        const interview = await interviewService.updateInterview(req.params.id, req.body || {});

        let emailResult = null;
        const becameScheduled =
            previous.status === INTERVIEW_STATUSES.DRAFT &&
            interview.status === INTERVIEW_STATUSES.SCHEDULED;
        const scheduleChanged =
            interview.status === INTERVIEW_STATUSES.SCHEDULED &&
            (previous.date !== interview.date ||
                previous.time !== interview.time ||
                previous.timezone !== interview.timezone);

        if ((becameScheduled || scheduleChanged) && !interview.invitationSent) {
            try {
                emailResult = await sendScheduledInterviewInvite(interview);
                if (emailResult?.success) {
                    await interviewService.markInvitationSent(interview.id);
                }
            } catch (emailErr) {
                console.error("⚠️ Invitation email failed on update:", emailErr.message);
                emailResult = { success: false, error: emailErr.message };
            }
        }

        return res.status(200).json({
            success: true,
            interview: await interviewService.getInterview(interview.id),
            email: emailResult,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * DELETE /api/interviews/:id
 */
exports.deleteInterview = async (req, res, next) => {
    try {
        await interviewService.removeInterview(req.params.id);
        return res.status(200).json({
            success: true,
            message: "Interview deleted.",
        });
    } catch (error) {
        next(error);
    }
};
