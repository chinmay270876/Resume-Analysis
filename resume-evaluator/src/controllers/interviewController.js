const { performance } = require("perf_hooks");
const interviewService = require("../services/interviewService");
const {
    sendScheduledInterviewInvite,
    sanitizeEmailError,
} = require("../services/emailService");
const { processReminders } = require("../services/interviewReminderService");
const { getResultDownloadBuffer } = require("../services/interviewResultService");
const { generateInterviewSummaryExcel } = require("../services/excelService");
const { INTERVIEW_STATUSES } = require("../models/interviewStatuses");

const INVITATION_EMAIL_TIMEOUT_MS = 25000;

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Send the candidate invitation and wait for the SMTP accept/reject result.
 * Interview persistence is already complete before this runs.
 */
async function deliverInvitationEmail(interview, reason = "create") {
    const interviewId = interview?.id || "unknown";
    const emailStarted = performance.now();
    try {
        console.log(`[Interview][${reason}] invitation email starting for ${interviewId}`);
        const emailResult = await withTimeout(
            sendScheduledInterviewInvite(interview),
            INVITATION_EMAIL_TIMEOUT_MS,
            "Candidate invitation email"
        );
        if (emailResult?.success) {
            await interviewService.markInvitationSent(interviewId);
            console.log(
                `[Interview][${reason}] invitation email accepted for ${interviewId} in ${(
                    performance.now() - emailStarted
                ).toFixed(1)}ms`
            );
            return {
                sent: true,
                success: true,
                messageId: emailResult.messageId || null,
            };
        }

        const error =
            emailResult?.error ||
            emailResult?.reason ||
            "Candidate invitation was not accepted by SMTP";
        console.warn(
            `[Interview][${reason}] invitation email not sent for ${interviewId}: ${error}`
        );
        return {
            sent: false,
            success: false,
            skipped: !!emailResult?.skipped,
            error,
        };
    } catch (emailErr) {
        const error = sanitizeEmailError(emailErr);
        console.error(
            `[Interview][${reason}] invitation email failed for ${interviewId} after ${(
                performance.now() - emailStarted
            ).toFixed(1)}ms: ${error}`
        );
        return { sent: false, success: false, error };
    }
}

/**
 * POST /api/interviews
 * Create a scheduled (or draft) interview, then deliver the invitation email.
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
            emailResult = await deliverInvitationEmail(interview, "create");
        }

        const totalMs = performance.now() - requestStarted;
        console.log(
            `[Interview][create] request completed in ${totalMs.toFixed(1)}ms ` +
                `(persist=${persistMs.toFixed(1)}ms, emailSent=${!!emailResult?.sent})`
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
            emailResult = await deliverInvitationEmail(interview, "update");
        }

        const totalMs = performance.now() - requestStarted;
        console.log(
            `[Interview][update] request completed in ${totalMs.toFixed(1)}ms ` +
                `(persist=${persistMs.toFixed(1)}ms, emailSent=${!!emailResult?.sent})`
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
            role: result.role || "student",
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
 * POST /api/interviews/:id/recruiter-token
 * Recruiter/admin join token. API-key gated. Never issues the candidate role.
 */
exports.issueRecruiterToken = async (req, res, next) => {
    try {
        const result = await interviewService.issueRecruiterRoomToken(
            req.params.id,
            req.body || {}
        );
        return res.status(200).json({
            success: true,
            token: result.token,
            roomId: result.roomId,
            role: result.role,
            interview: result.interview,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/100ms/webhook
 * Public 100ms lifecycle endpoint. Signature is verified before this handler.
 */
exports.handleHmsWebhook = async (req, res, next) => {
    try {
        const { verifyWebhookSignature } = require("../services/hmsTokenService");
        const verification = verifyWebhookSignature({
            rawBody: req.rawBody,
            headers: req.headers,
        });
        if (!verification.ok) {
            console.warn("[100MS] Webhook verification failed", {
                reason: verification.reason,
            });
            return res.status(401).json({
                success: false,
                error: "Invalid webhook signature.",
            });
        }

        const result = await interviewService.processHmsWebhook(req.body || {});
        return res.status(200).json({
            success: true,
            result,
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
