/**
 * Orchestrates post-live-interview completion:
 * Completed → store real transcript → evaluate from transcript → set hiring result.
 *
 * Does NOT generate fake conversations. Requires provider-submitted turns.
 */

const path = require("path");
const fsp = require("fs").promises;
const interviewStore = require("./interviewStore");
const podcastTranscriptService = require("./podcastTranscriptService");
const {
    evaluateFromRealTranscript,
    getEvaluationDownloadBuffer,
} = require("./voiceInterviewEvaluationService");
const {
    buildResultHistoryEntry,
    appendResultHistory,
    buildDownloadableFiles,
} = require("./interviewResultService");
const { generateInterviewSummaryExcel } = require("./excelService");
const {
    INTERVIEW_STATUSES,
    INTERVIEW_RESULTS,
    EVALUATION_STATUSES,
    POST_COMPLETION_STATUSES,
} = require("../models/interviewStatuses");

async function loadEnrichedInterview(interviewId) {
    // Lazy require avoids circular dependency with interviewService.
    const interviewService = require("./interviewService");
    return interviewService.getInterview(interviewId);
}

function createHttpError(message, status = 400, stage = "interview-completion") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

function apiTranscriptPath(interviewId) {
    return `/api/interviews/${interviewId}/transcript/download?format=txt`;
}

function apiRecordingPath(interviewId) {
    return `/api/interviews/${interviewId}/recording`;
}

function apiEvaluationPath(interviewId) {
    return `/api/interviews/${interviewId}/evaluation`;
}

function apiExcelPath(interviewId) {
    return `/api/interviews/${interviewId}/excel/download`;
}

async function persistEvaluationArtifact(interviewId, evaluation, result) {
    const dir = path.join(
        process.cwd(),
        process.env.REPORT_DIR || "results",
        "interview-evaluations"
    );
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${interviewId}_evaluation.json`);
    await fsp.writeFile(
        filePath,
        JSON.stringify({ interviewId, evaluation, result, createdAt: new Date().toISOString() }, null, 2),
        "utf8"
    );
    return filePath;
}

/**
 * Persist optional Excel summary after evaluation. Failures are non-fatal.
 */
async function persistExcelSummary(interviewSnapshot) {
    try {
        const excel = await generateInterviewSummaryExcel(interviewSnapshot);
        return {
            excelSummaryPath: excel.filepath,
            excelSummaryFilename: excel.filename,
            excelSummaryUrl: apiExcelPath(interviewSnapshot.id),
        };
    } catch (err) {
        console.error("[InterviewCompletion] Excel summary skipped:", err.message);
        return null;
    }
}

async function finalizeWithArtifacts(interviewId, evaluation, result) {
    const current = await interviewStore.getInterviewById(interviewId);
    const excelMeta = await persistExcelSummary({
        ...current,
        evaluation,
        result,
    });

    const historyEntry = buildResultHistoryEntry(current, evaluation, result);
    const withResult = {
        ...current,
        status: INTERVIEW_STATUSES.RESULT_GENERATED,
        result,
        evaluationId: historyEntry.evaluationId,
        resultGeneratedAt: historyEntry.generatedAt,
        resultHistory: appendResultHistory(current.resultHistory, historyEntry),
        ...(excelMeta || {}),
        updatedAt: new Date().toISOString(),
    };

    withResult.downloadableFiles = buildDownloadableFiles(withResult);

    return interviewStore.updateInterview(interviewId, () => withResult);
}

/**
 * Complete a live Voice AI interview with the real conversation turns.
 *
 * Body shape (provider-agnostic):
 * {
 *   lines: [{ timestamp, speaker: "AI"|"Candidate", text }],
 *   audioFilePath?: string,
 *   durationSeconds?: number,
 *   provider?: string,
 *   skipEvaluation?: boolean  // store transcript only (still requires real lines)
 * }
 */
async function completeLiveInterview(interviewId, payload = {}) {
    const interview = await interviewStore.getInterviewById(interviewId);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }

    if (interview.status === INTERVIEW_STATUSES.CANCELLED) {
        throw createHttpError("Cannot complete a cancelled interview.", 409);
    }

    if (POST_COMPLETION_STATUSES.includes(interview.status) && interview.transcriptId) {
        const existing = await podcastTranscriptService.getTranscriptByInterviewId(interviewId);
        if (existing) {
            throw createHttpError(
                "Interview already has a podcast transcript. Transcripts are created once from the live session.",
                409
            );
        }
    }

    const rawLines = payload.lines || payload.transcript || payload.turns || payload.messages;
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
        throw createHttpError(
            "Real interview transcript lines are required. The podcast transcript is never pre-generated."
        );
    }

    const now = new Date().toISOString();

    // 1) Mark Completed
    await interviewStore.updateInterview(interviewId, (current) => ({
        ...current,
        status: INTERVIEW_STATUSES.COMPLETED,
        updatedAt: now,
    }));

    // 2) Store real transcript → Transcript Generated
    const transcript = await podcastTranscriptService.createTranscriptFromLiveSession({
        interviewId,
        candidateId: interview.candidateId || interviewId,
        lines: rawLines,
        // Path is sanitized inside createTranscriptFromLiveSession (allowed dirs only)
        audioFilePath: payload.audioFilePath || payload.recordingPath || null,
        durationSeconds: payload.durationSeconds ?? payload.duration ?? null,
        provider: payload.provider || null,
    });

    let updated = await interviewStore.updateInterview(interviewId, (current) => ({
        ...current,
        status: INTERVIEW_STATUSES.TRANSCRIPT_GENERATED,
        transcriptId: transcript.transcriptId,
        transcriptPath: apiTranscriptPath(interviewId),
        recordingPath: transcript.audioFilePath
            ? apiRecordingPath(interviewId)
            : current.recordingPath || null,
        transcriptMeta: {
            transcriptId: transcript.transcriptId,
            createdAt: transcript.createdAt,
            duration: transcript.duration,
            wordCount: transcript.wordCount,
            evaluationStatus: transcript.evaluationStatus,
            lineCount: transcript.lines.length,
        },
        updatedAt: new Date().toISOString(),
    }));

    if (payload.skipEvaluation === true) {
        return {
            interview: await loadEnrichedInterview(interviewId),
            transcript: podcastTranscriptService.toPublicTranscript(transcript),
            evaluation: null,
        };
    }

    // 3) Evaluate from REAL transcript only → Evaluation Generated
    let evaluation = null;
    let result = INTERVIEW_RESULTS.PENDING;
    let evaluationStatus = EVALUATION_STATUSES.PENDING;

    try {
        const evalResult = await evaluateFromRealTranscript(transcript, updated);
        evaluation = evalResult.evaluation;
        result = evalResult.result;
        evaluationStatus = EVALUATION_STATUSES.GENERATED;

        await podcastTranscriptService.updateTranscript(interviewId, {
            evaluationStatus,
        });

        const evaluationFilePath = await persistEvaluationArtifact(
            interviewId,
            evaluation,
            result
        );

        updated = await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            status: INTERVIEW_STATUSES.EVALUATION_GENERATED,
            evaluation,
            evaluationPath: apiEvaluationPath(interviewId),
            evaluationFilePath,
            result: INTERVIEW_RESULTS.PENDING,
            transcriptMeta: {
                ...(current.transcriptMeta || {}),
                evaluationStatus,
            },
            updatedAt: new Date().toISOString(),
        }));

        // 4) Result Generated (+ Excel summary + downloadable file pointers)
        updated = await finalizeWithArtifacts(interviewId, evaluation, result);
    } catch (evalErr) {
        console.error("[InterviewCompletion] Evaluation failed:", evalErr.message);
        evaluationStatus = EVALUATION_STATUSES.FAILED;
        await podcastTranscriptService.updateTranscript(interviewId, {
            evaluationStatus,
        }).catch(() => {});

        updated = await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            status: INTERVIEW_STATUSES.TRANSCRIPT_GENERATED,
            transcriptMeta: {
                ...(current.transcriptMeta || {}),
                evaluationStatus,
                evaluationError: evalErr.message,
            },
            updatedAt: new Date().toISOString(),
        }));

        const wrapped = createHttpError(
            `Transcript stored, but evaluation failed: ${evalErr.message}`,
            502
        );
        wrapped.interview = await loadEnrichedInterview(interviewId);
        wrapped.transcript = podcastTranscriptService.toPublicTranscript(transcript);
        throw wrapped;
    }

    return {
        interview: await loadEnrichedInterview(interviewId),
        transcript: podcastTranscriptService.toPublicTranscript(transcript),
        evaluation,
        result,
    };
}

/**
 * Re-run AI Evaluation on an existing real podcast transcript.
 * Used when evaluation failed after transcript storage, or recruiter requests refresh.
 */
async function reEvaluateInterview(interviewId) {
    const interview = await interviewStore.getInterviewById(interviewId);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }

    const transcript = await podcastTranscriptService.getTranscriptByInterviewId(interviewId);
    if (!transcript?.lines?.length) {
        throw createHttpError(
            "No real podcast transcript available. Complete the live interview first.",
            400
        );
    }

    let evaluation = null;
    let result = INTERVIEW_RESULTS.PENDING;
    let evaluationStatus = EVALUATION_STATUSES.PENDING;

    try {
        const evalResult = await evaluateFromRealTranscript(transcript, interview);
        evaluation = evalResult.evaluation;
        result = evalResult.result;
        evaluationStatus = EVALUATION_STATUSES.GENERATED;

        await podcastTranscriptService.updateTranscript(interviewId, {
            evaluationStatus,
        });

        const evaluationFilePath = await persistEvaluationArtifact(
            interviewId,
            evaluation,
            result
        );

        await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            status: INTERVIEW_STATUSES.EVALUATION_GENERATED,
            evaluation,
            evaluationPath: apiEvaluationPath(interviewId),
            evaluationFilePath,
            result: INTERVIEW_RESULTS.PENDING,
            transcriptMeta: {
                ...(current.transcriptMeta || {}),
                evaluationStatus,
                evaluationError: null,
            },
            updatedAt: new Date().toISOString(),
        }));

        await finalizeWithArtifacts(interviewId, evaluation, result);
    } catch (evalErr) {
        console.error("[InterviewCompletion] Re-evaluation failed:", evalErr.message);
        evaluationStatus = EVALUATION_STATUSES.FAILED;
        await podcastTranscriptService.updateTranscript(interviewId, {
            evaluationStatus,
        }).catch(() => {});

        await interviewStore.updateInterview(interviewId, (current) => ({
            ...current,
            transcriptMeta: {
                ...(current.transcriptMeta || {}),
                evaluationStatus,
                evaluationError: evalErr.message,
            },
            updatedAt: new Date().toISOString(),
        }));

        const wrapped = createHttpError(
            `Evaluation failed: ${evalErr.message}`,
            502
        );
        wrapped.interview = await loadEnrichedInterview(interviewId);
        throw wrapped;
    }

    return {
        interview: await loadEnrichedInterview(interviewId),
        evaluation,
        result,
    };
}

/**
 * Idempotent completion: skip if a real transcript already exists.
 */
async function tryFinalizeInterview(interviewId, payload = {}) {
    const interview = await interviewStore.getInterviewById(interviewId);
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }
    if (interview.transcriptId) {
        const existing = await podcastTranscriptService.getTranscriptByInterviewId(interviewId);
        if (existing?.lines?.length) {
            return {
                interview: await loadEnrichedInterview(interviewId),
                transcript: podcastTranscriptService.toPublicTranscript(existing),
                evaluation: interview.evaluation || null,
                skipped: true,
            };
        }
    }
    return completeLiveInterview(interviewId, payload);
}

module.exports = {
    completeLiveInterview,
    tryFinalizeInterview,
    reEvaluateInterview,
    getEvaluationDownloadBuffer,
    apiTranscriptPath,
    apiRecordingPath,
    apiEvaluationPath,
};
