const { performance } = require("perf_hooks");
const interviewService = require("../services/interviewService");
const { sendScheduledInterviewInvite } = require("../services/emailService");
const { processReminders } = require("../services/interviewReminderService");
const { getResultDownloadBuffer } = require("../services/interviewResultService");
const { generateInterviewSummaryExcel } = require("../services/excelService");
const { INTERVIEW_STATUSES } = require("../models/interviewStatuses");

/**
 * Fire-and-forget invitation email so HTTP responses are not blocked by SMTP
 * (verify + sendMailWithRetry can take several seconds, especially on retries).
 */
function queueInvitationEmail(interview, reason = "create") {
    const interviewId = interview?.id || "unknown";
    setImmediate(() => {
        const emailStarted = performance.now();
        Promise.resolve()
            .then(async () => {
                console.log(
                    `[Interview][${reason}] background invitation email starting for ${interviewId}`
                );
                const emailResult = await sendScheduledInterviewInvite(interview);
                if (emailResult?.success) {
                    await interviewService.markInvitationSent(interviewId);
                } else if (emailResult?.skipped) {
                    console.warn(
                        `[Interview][${reason}] invitation email skipped for ${interviewId}:`,
                        emailResult.reason || "skipped"
                    );
                }
                console.log(
                    `[Interview][${reason}] background invitation email finished for ${interviewId} in ${(
                        performance.now() - emailStarted
                    ).toFixed(1)}ms`,
                    { success: !!emailResult?.success, skipped: !!emailResult?.skipped }
                );
            })
            .catch((emailErr) => {
                console.error(
                    `[Interview][${reason}] invitation email failed for ${interviewId} after ${(
                        performance.now() - emailStarted
                    ).toFixed(1)}ms:`,
                    emailErr.message
                );
            });
    });
}

/**
 * POST /api/interviews
 * Create a scheduled (or draft) interview and queue the invitation email in the background.
 */
exports.createInterview = async (req, res, next) => {
    const requestStarted = performance.now();
    try {
        const persistStarted = performance.now();
        const interview = await interviewService.createInterview(req.body || {});
        const persistMs = performance.now() - persistStarted;

        let emailResult = null;
        if (
            interview.status === INTERVIEW_STATUSES.SCHEDULED ||
            interview.status === INTERVIEW_STATUSES.REMINDER_SENT
        ) {
            // Return immediately after DB write; SMTP/email runs asynchronously.
            queueInvitationEmail(interview, "create");
            emailResult = { queued: true };
        }

        const totalMs = performance.now() - requestStarted;
        console.log(
            `[Interview][create] request completed in ${totalMs.toFixed(1)}ms ` +
                `(persist=${persistMs.toFixed(1)}ms, emailQueued=${!!emailResult?.queued})`
        );

        return res.status(201).json({
            success: true,
            interview,
            email: emailResult,
        });
    } catch (error) {
        console.error(
            `[Interview][create] request failed after ${(performance.now() - requestStarted).toFixed(1)}ms:`,
            error.message
        );
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
    const requestStarted = performance.now();
    try {
        const previous = await interviewService.getInterview(req.params.id);
        const persistStarted = performance.now();
        const interview = await interviewService.updateInterview(req.params.id, req.body || {});
        const persistMs = performance.now() - persistStarted;

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
            queueInvitationEmail(interview, "update");
            emailResult = { queued: true };
        }

        const totalMs = performance.now() - requestStarted;
        console.log(
            `[Interview][update] request completed in ${totalMs.toFixed(1)}ms ` +
                `(persist=${persistMs.toFixed(1)}ms, emailQueued=${!!emailResult?.queued})`
        );

        return res.status(200).json({
            success: true,
            interview,
            email: emailResult,
        });
    } catch (error) {
        console.error(
            `[Interview][update] request failed after ${(performance.now() - requestStarted).toFixed(1)}ms:`,
            error.message
        );
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

/**
 * POST /api/interviews/:id/token
 * Public candidate endpoint — issues a 100ms auth token for the interview room.
 */
exports.issueInterviewToken = async (req, res, next) => {
    try {
        const result = await interviewService.issueCandidateRoomToken(req.params.id);
        return res.status(200).json({
            success: true,
            token: result.token || null,
            roomId: result.roomId || null,
            candidateName: result.candidateName,
            interview: result.interview,
            questions: result.questions || result.interview?.questions || [],
            hmsError: result.hmsError || null,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/interviews/:id/answers
 * Public candidate endpoint — persist per-question transcripts under interviewDetails.
 */
exports.saveInterviewAnswers = async (req, res, next) => {
    try {
        const interview = await interviewService.saveCandidateAnswers(
            req.params.id,
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            interview,
            interviewDetails: interview.interviewDetails,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/interviews/:id/extend
 * Recruiter-only — extend expiresAt by +24 hours while the link is still valid.
 */
exports.extendInterviewLink = async (req, res, next) => {
    try {
        const interview = await interviewService.extendInterviewLink(req.params.id);
        return res.status(200).json({
            success: true,
            interview,
        });
    } catch (error) {
        next(error);
    }
};
