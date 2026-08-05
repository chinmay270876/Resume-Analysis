/**
 * Final Result Module — read-side aggregation + result report PDF.
 *
 * Does NOT re-score or invent outcomes. Decisions come from the AI Evaluation
 * already stored on the interview after transcript + evaluation complete.
 */

const { v4: uuidv4 } = require("uuid");
const interviewStore = require("./interviewStore");
const { buildSimplePdf } = require("./podcastTranscriptService");
const {
    INTERVIEW_STATUSES,
    INTERVIEW_RESULTS,
    POST_COMPLETION_STATUSES,
} = require("../models/interviewStatuses");

function createHttpError(message, status = 400, stage = "interview-result") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

function scoreOf(nested, flat) {
    if (nested && typeof nested === "object" && nested.score != null) {
        return nested.score;
    }
    if (typeof nested === "number") return nested;
    if (flat != null) return flat;
    return null;
}

function truncateWords(text, maxWords = 250) {
    const words = String(text || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
    if (words.length <= maxWords) return words.join(" ");
    return `${words.slice(0, maxWords).join(" ")}…`;
}

function listOrDash(items) {
    if (!Array.isArray(items) || items.length === 0) return ["- None listed"];
    return items.map((s) => `- ${s}`);
}

function resolveJobRole(interview) {
    if (interview?.jobRole) return interview.jobRole;
    const jd = interview?.jobDescription;
    if (jd && typeof jd === "object" && jd.jobTitle) return jd.jobTitle;
    const resume = interview?.resumeSummary;
    if (resume && typeof resume === "object") {
        return resume.role || resume.currentDesignation || "—";
    }
    return "—";
}

function resolveCompany(interview) {
    if (interview?.currentCompany) return interview.currentCompany;
    const resume = interview?.resumeSummary;
    if (resume && typeof resume === "object" && resume.currentCompany) {
        return resume.currentCompany;
    }
    return "—";
}

function formatDuration(interview) {
    const metaSec = interview?.transcriptMeta?.duration;
    if (metaSec != null && Number.isFinite(Number(metaSec))) {
        const total = Math.round(Number(metaSec));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}m ${String(s).padStart(2, "0")}s`;
    }
    if (interview?.durationMinutes) {
        return `${interview.durationMinutes} minutes (scheduled)`;
    }
    return "—";
}

/**
 * Build an immutable history entry when a hiring result is finalized.
 */
function buildResultHistoryEntry(interview, evaluation, result) {
    const now = new Date();
    const iso = now.toISOString();
    return {
        interviewId: interview.id,
        evaluationId: evaluation?.evaluationId || uuidv4(),
        result: result || INTERVIEW_RESULTS.PENDING,
        overallScore: evaluation?.overallScore ?? null,
        jdMatchPercent:
            scoreOf(evaluation?.jdMatch, evaluation?.jdMatchPercent) ?? null,
        recommendation: evaluation?.recommendation || null,
        generatedAt: iso,
        generatedDate: iso.slice(0, 10),
        generatedTime: iso.slice(11, 19),
    };
}

/**
 * Append history without overwriting prior results (re-evaluations keep history).
 */
function appendResultHistory(existingHistory, entry) {
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
    history.push(entry);
    return history;
}

/**
 * Dashboard summary counters across all interviews.
 */
async function getInterviewStats() {
    const interviews = await interviewStore.getAllInterviews();

    const stats = {
        total: interviews.length,
        scheduled: 0,
        completed: 0,
        selected: 0,
        rejected: 0,
        pending: 0,
        pendingEvaluation: 0,
        cancelled: 0,
        inProgress: 0,
        reminderSent: 0,
        averageJdMatch: null,
        averageTechnicalScore: null,
        averageCommunicationScore: null,
        averageInterviewDurationMinutes: null,
    };

    let jdSum = 0;
    let jdCount = 0;
    let techSum = 0;
    let techCount = 0;
    let commSum = 0;
    let commCount = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const item of interviews) {
        const status = item.status;
        const result = item.result || INTERVIEW_RESULTS.PENDING;

        if (status === INTERVIEW_STATUSES.SCHEDULED) stats.scheduled += 1;
        if (status === INTERVIEW_STATUSES.REMINDER_SENT) stats.reminderSent += 1;
        if (status === INTERVIEW_STATUSES.IN_PROGRESS) stats.inProgress += 1;
        if (status === INTERVIEW_STATUSES.CANCELLED) stats.cancelled += 1;
        if (POST_COMPLETION_STATUSES.includes(status)) stats.completed += 1;

        if (result === INTERVIEW_RESULTS.SELECTED) stats.selected += 1;
        else if (result === INTERVIEW_RESULTS.REJECTED) stats.rejected += 1;
        else stats.pending += 1;

        const awaitingEval =
            status === INTERVIEW_STATUSES.COMPLETED ||
            status === INTERVIEW_STATUSES.TRANSCRIPT_GENERATED ||
            (status === INTERVIEW_STATUSES.EVALUATION_GENERATED &&
                result === INTERVIEW_RESULTS.PENDING) ||
            (POST_COMPLETION_STATUSES.includes(status) &&
                !item.evaluation &&
                result === INTERVIEW_RESULTS.PENDING);

        if (awaitingEval) stats.pendingEvaluation += 1;

        const evaluation = item.evaluation;
        if (evaluation) {
            const jd = scoreOf(evaluation.jdMatch, evaluation.jdMatchPercent);
            if (jd != null && Number.isFinite(Number(jd))) {
                jdSum += Number(jd);
                jdCount += 1;
            }
            const tech = scoreOf(evaluation.technicalKnowledge, evaluation.technicalScore);
            if (tech != null && Number.isFinite(Number(tech))) {
                techSum += Number(tech);
                techCount += 1;
            }
            const comm = scoreOf(evaluation.communication, evaluation.communicationScore);
            if (comm != null && Number.isFinite(Number(comm))) {
                commSum += Number(comm);
                commCount += 1;
            }
        }

        const metaSec = item.transcriptMeta?.duration;
        if (metaSec != null && Number.isFinite(Number(metaSec))) {
            durationSum += Number(metaSec) / 60;
            durationCount += 1;
        } else if (POST_COMPLETION_STATUSES.includes(status) && item.durationMinutes) {
            durationSum += Number(item.durationMinutes);
            durationCount += 1;
        }
    }

    const avg = (sum, count) =>
        count > 0 ? Math.round((sum / count) * 10) / 10 : null;

    stats.averageJdMatch = avg(jdSum, jdCount);
    stats.averageTechnicalScore = avg(techSum, techCount);
    stats.averageCommunicationScore = avg(commSum, commCount);
    stats.averageInterviewDurationMinutes = avg(durationSum, durationCount);

    return stats;
}

/**
 * Rank evaluated candidates by composite interview scores.
 * Highest overall (or average of score dimensions) becomes Rank 1.
 */
function buildCandidateRanking(interviews, { limit = 50 } = {}) {
    const evaluated = (interviews || []).filter(
        (item) =>
            item?.evaluation &&
            (item.status === INTERVIEW_STATUSES.RESULT_GENERATED ||
                item.status === INTERVIEW_STATUSES.EVALUATION_GENERATED ||
                item.result === INTERVIEW_RESULTS.SELECTED ||
                item.result === INTERVIEW_RESULTS.REJECTED)
    );

    const rows = evaluated.map((item) => {
        const evaluation = item.evaluation;
        const technical = scoreOf(evaluation.technicalKnowledge, evaluation.technicalScore);
        const communication = scoreOf(evaluation.communication, evaluation.communicationScore);
        const problemSolving = scoreOf(
            evaluation.problemSolving,
            evaluation.problemSolvingScore
        );
        const behaviour = scoreOf(evaluation.behaviour, evaluation.behaviourScore);
        const confidence = scoreOf(evaluation.confidence, evaluation.confidencePercent);
        const jdMatch = scoreOf(evaluation.jdMatch, evaluation.jdMatchPercent);
        const overall =
            evaluation.overallScore != null && Number.isFinite(Number(evaluation.overallScore))
                ? Number(evaluation.overallScore)
                : null;

        const dims = [technical, communication, problemSolving, behaviour, confidence, jdMatch]
            .filter((n) => n != null && Number.isFinite(Number(n)))
            .map(Number);
        const composite =
            overall != null
                ? overall
                : dims.length
                  ? dims.reduce((a, b) => a + b, 0) / dims.length
                  : -1;

        return {
            interviewId: item.id,
            candidateId: item.candidateId || item.id,
            candidateName: item.candidateName || "—",
            jobRole: resolveJobRole(item),
            currentCompany: resolveCompany(item),
            interviewDate: item.date || item.interviewDate || null,
            technical,
            communication,
            problemSolving,
            behaviour,
            confidence,
            jdMatch,
            overallScore: overall,
            rankingScore: Math.round(composite * 10) / 10,
            recommendation: evaluation.recommendation || null,
            result: item.result || INTERVIEW_RESULTS.PENDING,
            strengths: Array.isArray(evaluation.strengths) ? evaluation.strengths : [],
            weaknesses: Array.isArray(evaluation.weaknesses) ? evaluation.weaknesses : [],
            resumeSummary: item.resumeSummary || null,
        };
    });

    rows.sort((a, b) => {
        if (b.rankingScore !== a.rankingScore) return b.rankingScore - a.rankingScore;
        return (a.candidateName || "").localeCompare(b.candidateName || "", undefined, {
            sensitivity: "base",
        });
    });

    const capped = rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
    return capped.map((row, index) => ({
        ...row,
        rank: index + 1,
    }));
}

/**
 * Side-by-side compare payload for selected interview IDs.
 */
function buildCandidateCompare(interviews, ids = []) {
    const idSet = new Set((ids || []).map(String).filter(Boolean));
    const selected = (interviews || []).filter((item) => idSet.has(String(item.id)));

    return selected.map((item) => {
        const evaluation = item.evaluation || null;
        return {
            interviewId: item.id,
            candidateName: item.candidateName || "—",
            jobRole: resolveJobRole(item),
            currentCompany: resolveCompany(item),
            resume: item.resumeSummary || null,
            jdMatch: evaluation
                ? scoreOf(evaluation.jdMatch, evaluation.jdMatchPercent)
                : null,
            technical: evaluation
                ? scoreOf(evaluation.technicalKnowledge, evaluation.technicalScore)
                : null,
            communication: evaluation
                ? scoreOf(evaluation.communication, evaluation.communicationScore)
                : null,
            problemSolving: evaluation
                ? scoreOf(evaluation.problemSolving, evaluation.problemSolvingScore)
                : null,
            behaviour: evaluation
                ? scoreOf(evaluation.behaviour, evaluation.behaviourScore)
                : null,
            confidence: evaluation
                ? scoreOf(evaluation.confidence, evaluation.confidencePercent)
                : null,
            overallScore: evaluation?.overallScore ?? null,
            strengths: evaluation?.strengths || [],
            weaknesses: evaluation?.weaknesses || [],
            recommendation: evaluation?.recommendation || null,
            result: item.result || INTERVIEW_RESULTS.PENDING,
            interviewDate: item.date || item.interviewDate || null,
            status: item.status,
        };
    });
}

/**
 * Build downloadable artifact pointers for a completed + evaluated interview.
 */
function buildDownloadableFiles(interview) {
    if (!interview?.id) return null;
    const hasTranscript = !!(interview.transcriptId || interview.transcriptPath);
    const hasEvaluation = !!interview.evaluation;
    const hasRecording = !!interview.recordingPath;
    const hasExcel = !!(interview.excelSummaryPath || interview.downloadableFiles?.excelSummary);
    const generatedAt =
        interview.resultGeneratedAt ||
        interview.evaluation?.evaluatedAt ||
        interview.updatedAt ||
        null;

    return {
        interviewId: interview.id,
        transcriptFile: hasTranscript
            ? `/api/interviews/${interview.id}/transcript/download?format=pdf`
            : null,
        recordingFile: hasRecording ? `/api/interviews/${interview.id}/recording` : null,
        evaluationPdf: hasEvaluation
            ? `/api/interviews/${interview.id}/evaluation/download?format=pdf`
            : null,
        excelSummary: hasExcel || hasEvaluation
            ? `/api/interviews/${interview.id}/excel/download`
            : null,
        creationDate: interview.createdAt || null,
        createdBy: interview.createdBy || "system",
        generatedTimestamp: generatedAt,
    };
}

function formatResultReportText(interview) {
    const evaluation = interview?.evaluation;
    if (!evaluation) {
        throw createHttpError("No AI evaluation available yet. Result report requires a completed evaluation.", 404);
    }

    const result =
        interview.result ||
        evaluation.result ||
        INTERVIEW_RESULTS.PENDING;
    const generatedAt =
        interview.resultGeneratedAt ||
        evaluation.evaluatedAt ||
        new Date().toISOString();

    const jd = interview.jobDescription && typeof interview.jobDescription === "object"
        ? interview.jobDescription
        : null;
    const resume =
        interview.resumeSummary && typeof interview.resumeSummary === "object"
            ? interview.resumeSummary
            : null;

    const jdSummary = [
        jd?.jobTitle ? `Title: ${jd.jobTitle}` : null,
        jd?.domain ? `Domain: ${jd.domain}` : null,
        jd?.roleDescription ? `Description: ${jd.roleDescription}` : null,
        Array.isArray(jd?.mandatorySkills) && jd.mandatorySkills.length
            ? `Mandatory Skills: ${jd.mandatorySkills.join(", ")}`
            : null,
    ]
        .filter(Boolean)
        .join("\n");

    const resumeSummary = [
        resume?.candidateName ? `Name: ${resume.candidateName}` : `Name: ${interview.candidateName}`,
        resume?.currentCompany || interview.currentCompany
            ? `Company: ${resume?.currentCompany || interview.currentCompany}`
            : null,
        resume?.yearsOfExperience
            ? `Experience: ${resume.yearsOfExperience}`
            : null,
        Array.isArray(resume?.skills) && resume.skills.length
            ? `Skills: ${resume.skills.join(", ")}`
            : null,
        Array.isArray(resume?.strengths) && resume.strengths.length
            ? `Resume Strengths: ${resume.strengths.join(", ")}`
            : null,
    ]
        .filter(Boolean)
        .join("\n");

    const lines = [
        "═══════════════════════════════════════",
        "       FINAL HIRING RESULT REPORT",
        "═══════════════════════════════════════",
        "",
        "[ Company Logo Placeholder ]",
        "",
        "CANDIDATE INFORMATION",
        `Candidate: ${interview.candidateName || "—"}`,
        `Email: ${interview.candidateEmail || "—"}`,
        `Applied Role: ${resolveJobRole(interview)}`,
        `Current Company: ${resolveCompany(interview)}`,
        `Interview ID: ${interview.id}`,
        `Evaluation ID: ${interview.evaluationId || evaluation.evaluationId || "—"}`,
        "",
        "INTERVIEW METADATA",
        `Interview Date: ${interview.date || "—"}`,
        `Interview Time: ${interview.time || "—"}`,
        `Timezone: ${interview.timezone || "—"}`,
        `Interview Duration: ${formatDuration(interview)}`,
        `Interview Status: ${interview.status || "—"}`,
        "",
        "JOB DESCRIPTION SUMMARY",
        jdSummary || "—",
        "",
        "RESUME SUMMARY",
        resumeSummary || "—",
        "",
        "TECHNICAL SCORES",
        `Overall Interview Score: ${evaluation.overallScore ?? "—"} / 100`,
        `Technical: ${scoreOf(evaluation.technicalKnowledge, evaluation.technicalScore) ?? "—"}`,
        `Communication: ${scoreOf(evaluation.communication, evaluation.communicationScore) ?? "—"}`,
        `Problem Solving: ${scoreOf(evaluation.problemSolving, evaluation.problemSolvingScore) ?? "—"}`,
        `Confidence: ${scoreOf(evaluation.confidence, evaluation.confidencePercent) ?? "—"}`,
        `Behaviour: ${scoreOf(evaluation.behaviour, evaluation.behaviourScore) ?? "—"}`,
        `JD Match: ${scoreOf(evaluation.jdMatch, evaluation.jdMatchPercent) ?? "—"}%`,
        "",
        "STRENGTHS",
        ...listOrDash(evaluation.strengths),
        "",
        "WEAKNESSES",
        ...listOrDash(evaluation.weaknesses),
        "",
        "MISSING SKILLS",
        ...listOrDash(evaluation.missingSkills),
        "",
        "RECOMMENDATION",
        evaluation.recommendation || "—",
        "",
        "FINAL RESULT",
        result,
        "",
        "RESULT SUMMARY",
        truncateWords(evaluation.summary || "—", 250),
        "",
        `Generated Date: ${String(generatedAt).slice(0, 10)}`,
        `Generated Time: ${String(generatedAt).slice(11, 19) || "—"}`,
        `Generated At (UTC): ${generatedAt}`,
        "",
        "Source: AI Evaluation (live interview transcript)",
        "This report is for authorized recruiters only.",
    ];

    return lines.join("\n");
}

/**
 * Professional PDF / TXT download for the Final Result report.
 */
function getResultDownloadBuffer(interview, format = "pdf") {
    if (!interview) {
        throw createHttpError("Interview not found.", 404);
    }

    const hasResult =
        interview.status === INTERVIEW_STATUSES.RESULT_GENERATED ||
        (interview.evaluation &&
            (interview.result === INTERVIEW_RESULTS.SELECTED ||
                interview.result === INTERVIEW_RESULTS.REJECTED));

    if (!interview.evaluation || !hasResult) {
        throw createHttpError(
            "Final result is only available after interview completion, transcript generation, and AI evaluation.",
            404
        );
    }

    const plainText = formatResultReportText(interview);
    const baseName = `${interview.id}_final_result_report`;

    if (String(format).toLowerCase() === "txt") {
        return {
            buffer: Buffer.from(plainText, "utf8"),
            contentType: "text/plain; charset=utf-8",
            filename: `${baseName}.txt`,
        };
    }

    return {
        buffer: buildSimplePdf("Final Hiring Result Report", plainText),
        contentType: "application/pdf",
        filename: `${baseName}.pdf`,
    };
}

module.exports = {
    buildResultHistoryEntry,
    appendResultHistory,
    getInterviewStats,
    getResultDownloadBuffer,
    formatResultReportText,
    buildCandidateRanking,
    buildCandidateCompare,
    buildDownloadableFiles,
    resolveJobRole,
    resolveCompany,
    formatDuration,
    scoreOf,
};
