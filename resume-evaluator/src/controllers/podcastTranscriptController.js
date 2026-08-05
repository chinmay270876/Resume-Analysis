const path = require("path");
const fsp = require("fs").promises;
const interviewService = require("../services/interviewService");
const podcastTranscriptService = require("../services/podcastTranscriptService");
const {
    completeLiveInterview,
    reEvaluateInterview,
    getEvaluationDownloadBuffer,
} = require("../services/interviewCompletionService");
const { POST_COMPLETION_STATUSES } = require("../models/interviewStatuses");

/**
 * POST /api/interviews/:id/complete
 * Voice AI provider webhook — submit real conversation turns after the live session.
 */
exports.completeInterview = async (req, res, next) => {
    try {
        const result = await completeLiveInterview(req.params.id, req.body || {});
        return res.status(200).json({
            success: true,
            message: "Interview completed. Podcast transcript and evaluation generated from the live session.",
            interview: result.interview,
            transcript: result.transcript,
            evaluation: result.evaluation,
            result: result.result,
        });
    } catch (error) {
        if (error.status === 502 && error.interview) {
            return res.status(502).json({
                success: false,
                error: error.message,
                stage: error.stage || "interview-completion",
                interview: error.interview,
                transcript: error.transcript || null,
            });
        }
        next(error);
    }
};

/**
 * GET /api/interviews/:id/transcript
 * Query: q (keyword), speaker, timestamp
 */
exports.getTranscript = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);
        const transcript = await podcastTranscriptService.getTranscriptByInterviewId(
            req.params.id
        );

        if (!transcript) {
            return res.status(200).json({
                success: true,
                available: false,
                message: "No transcript available yet.",
                interviewId: interview.id,
                status: interview.status,
                transcript: null,
            });
        }

        const filtered = podcastTranscriptService.searchTranscript(transcript, {
            q: req.query.q || req.query.search || req.query.keyword,
            speaker: req.query.speaker,
            timestamp: req.query.timestamp || req.query.time,
        });

        return res.status(200).json({
            success: true,
            available: true,
            interviewId: interview.id,
            candidateId: interview.candidateId,
            status: interview.status,
            transcript: podcastTranscriptService.toPublicTranscript(transcript, {
                lines: filtered,
            }),
            totalLines: transcript.lines.length,
            matchedLines: filtered.length,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/:id/transcript/download?format=txt|pdf
 */
exports.downloadTranscript = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);
        const format = String(req.query.format || "txt").toLowerCase() === "pdf" ? "pdf" : "txt";
        const file = await podcastTranscriptService.getTranscriptDownloadBuffer(
            req.params.id,
            format,
            interview
        );

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
 * GET /api/interviews/:id/recording
 * Downloads the original interview audio when linked on the transcript.
 */
exports.downloadRecording = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);
        const transcript = await podcastTranscriptService.getTranscriptByInterviewId(
            req.params.id
        );

        const audioRef =
            transcript?.audioFilePath ||
            (interview.recordingPath && !interview.recordingPath.startsWith("/api/")
                ? interview.recordingPath
                : null);

        if (!audioRef) {
            const err = new Error("No audio recording available yet.");
            err.status = 404;
            err.stage = "podcast-transcript";
            throw err;
        }

        const candidates = podcastTranscriptService.resolveAudioAbsolutePath(audioRef);
        let filePath = null;
        if (Array.isArray(candidates)) {
            for (const candidate of candidates) {
                try {
                    await fsp.access(candidate);
                    filePath = candidate;
                    break;
                } catch {
                    // try next
                }
            }
        }

        if (!filePath) {
            const err = new Error(
                candidates == null
                    ? "Invalid or disallowed audio recording path."
                    : "Audio recording file not found on server."
            );
            err.status = candidates == null ? 400 : 404;
            err.stage = "podcast-transcript";
            throw err;
        }

        return res.download(filePath, path.basename(filePath));
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/:id/evaluation
 */
exports.getEvaluation = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);

        if (!POST_COMPLETION_STATUSES.includes(interview.status) || !interview.evaluation) {
            return res.status(200).json({
                success: true,
                available: false,
                message: "Waiting for Interview Completion",
                evaluation: null,
                result: interview.result || "Pending",
            });
        }

        return res.status(200).json({
            success: true,
            available: true,
            interviewId: interview.id,
            status: interview.status,
            evaluation: interview.evaluation,
            result: interview.result,
            evaluationPath: interview.evaluationPath,
        });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/interviews/:id/evaluation/download?format=pdf|txt
 */
exports.downloadEvaluation = async (req, res, next) => {
    try {
        const interview = await interviewService.getInterview(req.params.id);
        const format =
            String(req.query.format || "pdf").toLowerCase() === "txt" ? "txt" : "pdf";
        const file = getEvaluationDownloadBuffer(interview, format);

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
 * POST /api/interviews/:id/evaluate
 * Re-run AI Evaluation from the stored real podcast transcript.
 */
exports.reEvaluate = async (req, res, next) => {
    try {
        const result = await reEvaluateInterview(req.params.id);
        return res.status(200).json({
            success: true,
            message: "AI Evaluation generated from the real podcast transcript.",
            interview: result.interview,
            evaluation: result.evaluation,
            result: result.result,
        });
    } catch (error) {
        if (error.status === 502 && error.interview) {
            return res.status(502).json({
                success: false,
                error: error.message,
                stage: error.stage || "interview-completion",
                interview: error.interview,
            });
        }
        next(error);
    }
};
