const interviewService = require("../services/interviewService");
const { sendScheduledInterviewInvite } = require("../services/emailService");
const { processReminders } = require("../services/interviewReminderService");
const { getResultDownloadBuffer } = require("../services/interviewResultService");
const { generateInterviewSummaryExcel } = require("../services/excelService");
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
 * Query: filter, status, result, search, sortBy, sortDir, page, pageSize
 */
exports.listInterviews = async (req, res, next) => {
    try {
        const { interviews, pagination } = await interviewService.listInterviews({
            filter: req.query.filter,
            status: req.query.status,
            result: req.query.result,
            search: req.query.search || req.query.q,
            sortBy: req.query.sortBy || req.query.sort,
            sortDir: req.query.sortDir || req.query.order,
            page: req.query.page,
            pageSize: req.query.pageSize || req.query.limit,
        });

        return res.status(200).json({
            success: true,
            count: pagination.total,
            page: pagination.page,
            pageSize: pagination.pageSize,
            totalPages: pagination.totalPages,
            interviews,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/stats
 * Dashboard summary counters for Interview Management.
 */
exports.getInterviewStats = async (req, res, next) => {
    try {
        const stats = await interviewService.getInterviewStats();
        return res.status(200).json({
            success: true,
            stats,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/ranking
 * Candidate ranking from completed AI evaluations (highest score = Rank 1).
 */
exports.getCandidateRanking = async (req, res, next) => {
    try {
        const limit = req.query.limit != null ? Number(req.query.limit) : 50;
        const rankings = await interviewService.getCandidateRanking({ limit });
        return res.status(200).json({
            success: true,
            count: rankings.length,
            rankings,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/compare?ids=id1,id2,id3
 * Side-by-side candidate comparison for recruiters.
 */
exports.compareCandidates = async (req, res, next) => {
    try {
        const raw = req.query.ids || req.query.id || "";
        const ids = String(raw)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (ids.length < 2) {
            const err = new Error("Provide at least two interview ids via ?ids=id1,id2");
            err.status = 400;
            throw err;
        }
        if (ids.length > 5) {
            const err = new Error("Compare supports at most 5 candidates at a time.");
            err.status = 400;
            throw err;
        }

        const candidates = await interviewService.compareCandidates(ids);
        return res.status(200).json({
            success: true,
            count: candidates.length,
            candidates,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/:id/result/download?format=pdf|txt
 * Final Result report (requires completed evaluation + hiring result).
 * Recruiter-only via existing API key gate on /api/*.
 */
exports.downloadResultReport = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);
        const format = String(req.query.format || "pdf").toLowerCase();
        const file = getResultDownloadBuffer(interview, format);
        res.setHeader("Content-Type", file.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${file.filename}"`
        );
        return res.status(200).send(file.buffer);
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/:id/excel/download
 * Optional Excel summary — available only after AI evaluation finishes.
 */
exports.downloadExcelSummary = async (req, res, next) => {
    try {
        const fsp = require("fs").promises;
        const interview = await interviewService.getInterview(req.params.id);

        if (!interview.evaluation) {
            const err = new Error(
                "Excel summary is only available after interview completion and AI evaluation."
            );
            err.status = 404;
            throw err;
        }

        // Prefer persisted file; regenerate if missing (legacy interviews).
        let file;
        if (interview.excelSummaryPath) {
            try {
                const buffer = await fsp.readFile(interview.excelSummaryPath);
                file = {
                    buffer,
                    contentType:
                        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    filename:
                        interview.excelSummaryFilename ||
                        `${interview.id}_interview_summary.xlsx`,
                };
            } catch {
                file = null;
            }
        }

        if (!file) {
            const generated = await generateInterviewSummaryExcel(interview);
            const interviewStore = require("../services/interviewStore");
            await interviewStore.updateInterview(interview.id, (current) => ({
                ...current,
                excelSummaryPath: generated.filepath,
                excelSummaryFilename: generated.filename,
                excelSummaryUrl: `/api/interviews/${interview.id}/excel/download`,
                updatedAt: new Date().toISOString(),
            }));
            const buffer = await fsp.readFile(generated.filepath);
            file = {
                buffer,
                contentType:
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                filename: generated.filename,
            };
        }

        res.setHeader("Content-Type", file.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${file.filename}"`
        );
        return res.status(200).send(file.buffer);
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
            (interview.status === INTERVIEW_STATUSES.SCHEDULED ||
                interview.status === INTERVIEW_STATUSES.REMINDER_SENT) &&
            (previous.date !== interview.date ||
                previous.time !== interview.time ||
                previous.timezone !== interview.timezone ||
                previous.durationMinutes !== interview.durationMinutes);

        if (becameScheduled || scheduleChanged) {
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

/**
 * POST /api/interviews/reminders/process
 * Manual / Render Cron trigger for the same reminder processor used by the in-process scheduler.
 * Idempotent: sent flags prevent duplicate emails.
 */
exports.processRemindersNow = async (req, res, next) => {
    try {
        const result = await processReminders();
        return res.status(200).json({
            success: true,
            result,
        });
    } catch (error) {
        next(error);
    }
};
