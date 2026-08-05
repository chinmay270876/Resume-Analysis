/**
 * AI Evaluation Engine — scores a candidate from a REAL live-interview
 * podcast transcript only (Resume + JD as context). Never uses mock interviews.
 */

const fs = require("fs").promises;
const path = require("path");
const { getAiResponse } = require("./openaiService");
const { formatPlainText, buildSimplePdf } = require("./podcastTranscriptService");
const { INTERVIEW_RESULTS } = require("../models/interviewStatuses");

const templateCache = new Map();

/** Weighted overall score: Technical 40%, JD Match 25%, Problem Solving 15%, Communication 10%, Behaviour 10%. */
const SCORE_WEIGHTS = Object.freeze({
    technical: 0.4,
    jdMatch: 0.25,
    problemSolving: 0.15,
    communication: 0.1,
    behaviour: 0.1,
});

const RECOMMENDATIONS = Object.freeze([
    "Strongly Recommended",
    "Recommended",
    "Recommended with Training",
    "Borderline",
    "Rejected",
]);

async function getPromptTemplate() {
    if (templateCache.has("voice-eval")) {
        return templateCache.get("voice-eval");
    }
    const promptTemplate = await fs.readFile(
        path.join(process.cwd(), "templates", "voice-interview-evaluation-prompt.txt"),
        "utf-8"
    );
    templateCache.set("voice-eval", promptTemplate);
    return promptTemplate;
}

function clampScore(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.min(100, Math.round(num)));
}

function scoreBlock(raw) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return {
            score: clampScore(raw.score),
            reason: typeof raw.reason === "string" ? raw.reason.trim() : "",
        };
    }
    return {
        score: clampScore(raw),
        reason: "",
    };
}

function stringList(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => (typeof item === "string" ? item.trim() : String(item || "").trim()))
        .filter(Boolean);
}

function selectedThreshold() {
    const raw = Number(process.env.EVALUATION_SELECTED_THRESHOLD);
    if (Number.isFinite(raw) && raw >= 0 && raw <= 100) return Math.round(raw);
    return 80;
}

function computeOverallScore(scores) {
    const technical = scores.technicalKnowledge?.score ?? 0;
    const jdMatch = scores.jdMatch?.score ?? 0;
    const problemSolving = scores.problemSolving?.score ?? 0;
    const communication = scores.communication?.score ?? 0;
    const behaviour = scores.behaviour?.score ?? 0;

    const overall =
        technical * SCORE_WEIGHTS.technical +
        jdMatch * SCORE_WEIGHTS.jdMatch +
        problemSolving * SCORE_WEIGHTS.problemSolving +
        communication * SCORE_WEIGHTS.communication +
        behaviour * SCORE_WEIGHTS.behaviour;

    return clampScore(overall);
}

/**
 * Map overall score → recommendation tier. AI suggestion is used only as a soft
 * hint when overall is near a boundary; final value is always score-driven.
 */
function deriveRecommendation(overallScore, aiSuggestion) {
    const overall = overallScore ?? 0;
    let tier;
    if (overall >= 90) tier = "Strongly Recommended";
    else if (overall >= 80) tier = "Recommended";
    else if (overall >= 70) tier = "Recommended with Training";
    else if (overall >= 60) tier = "Borderline";
    else tier = "Rejected";

    const hint = String(aiSuggestion || "").trim();
    const normalizedHint = RECOMMENDATIONS.find(
        (r) => r.toLowerCase() === hint.toLowerCase()
    );

    // Allow AI to nudge one tier down when overall is within 3 points of a boundary
    // and the model is more cautious — never upgrade above score-based tier.
    if (normalizedHint) {
        const scoreIdx = RECOMMENDATIONS.indexOf(tier);
        const hintIdx = RECOMMENDATIONS.indexOf(normalizedHint);
        if (hintIdx > scoreIdx && hintIdx - scoreIdx === 1) {
            const boundary =
                tier === "Strongly Recommended"
                    ? 90
                    : tier === "Recommended"
                      ? 80
                      : tier === "Recommended with Training"
                        ? 70
                        : tier === "Borderline"
                          ? 60
                          : 0;
            if (overall < boundary + 3) {
                return normalizedHint;
            }
        }
    }

    return tier;
}

function deriveResult(overallScore) {
    const threshold = selectedThreshold();
    if ((overallScore ?? 0) >= threshold) {
        return INTERVIEW_RESULTS.SELECTED;
    }
    return INTERVIEW_RESULTS.REJECTED;
}

function buildInterviewMetadata(interview = {}, transcript = {}) {
    const resume = interview.resumeSummary || {};
    return {
        candidateName:
            interview.candidateName || resume.candidateName || "Unknown",
        candidateEmail: interview.candidateEmail || resume.email || null,
        roleAppliedFor:
            interview.jobRole ||
            resume.role ||
            resume.currentDesignation ||
            interview.jobDescription?.jobTitle ||
            null,
        currentCompany: interview.currentCompany || resume.currentCompany || null,
        currentProject: resume.additional || resume.experience || null,
        yearsOfExperience: resume.yearsOfExperience || null,
        durationSeconds:
            transcript.duration ??
            interview.transcriptMeta?.duration ??
            (interview.durationMinutes != null
                ? interview.durationMinutes * 60
                : null),
        scheduledDurationMinutes: interview.durationMinutes || null,
        interviewDate: interview.date || null,
        interviewTime: interview.time || null,
        timezone: interview.timezone || null,
        provider: transcript.provider || null,
        transcriptLineCount: Array.isArray(transcript.lines)
            ? transcript.lines.length
            : null,
        transcriptWordCount: transcript.wordCount || null,
    };
}

const categorySchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        score: { type: "number" },
        reason: { type: "string" },
    },
    required: ["score", "reason"],
};

/**
 * @param {object} transcript - Podcast transcript record with lines[]
 * @param {object} interview - Scheduled interview (jobDescription, resumeSummary, metadata)
 */
async function evaluateFromRealTranscript(transcript, interview = {}) {
    if (!transcript?.lines?.length) {
        const err = new Error(
            "Cannot evaluate without a real interview transcript. Evaluation must not use fake interviews."
        );
        err.status = 400;
        err.stage = "voice-interview-evaluation";
        throw err;
    }

    const promptTemplate = await getPromptTemplate();
    const transcriptText = formatPlainText(transcript);
    const jobDescription = interview.jobDescription
        ? JSON.stringify(interview.jobDescription, null, 2)
        : "Not provided.";
    const resumeSummary = interview.resumeSummary
        ? JSON.stringify(interview.resumeSummary, null, 2)
        : "Not provided.";
    const interviewMetadata = JSON.stringify(
        buildInterviewMetadata(interview, transcript),
        null,
        2
    );

    const prompt = promptTemplate
        .replace("{{transcriptText}}", transcriptText)
        .replace("{{jobDescription}}", jobDescription)
        .replace("{{resumeSummary}}", resumeSummary)
        .replace("{{interviewMetadata}}", interviewMetadata);

    const model =
        process.env.OPENAI_VOICE_EVALUATION_MODEL ||
        process.env.OPENAI_EVALUATION_MODEL ||
        process.env.MODEL_NAME ||
        "gpt-4o-mini";

    const evaluationSchema = {
        type: "json_schema",
        json_schema: {
            name: "voice_interview_evaluation",
            strict: true,
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    technicalKnowledge: categorySchema,
                    communication: categorySchema,
                    problemSolving: categorySchema,
                    confidence: categorySchema,
                    behaviour: categorySchema,
                    jdMatch: categorySchema,
                    strengths: { type: "array", items: { type: "string" } },
                    weaknesses: { type: "array", items: { type: "string" } },
                    missingSkills: { type: "array", items: { type: "string" } },
                    knowledgeGaps: { type: "array", items: { type: "string" } },
                    redFlags: { type: "array", items: { type: "string" } },
                    potential: { type: "array", items: { type: "string" } },
                    hiringRisks: { type: "array", items: { type: "string" } },
                    summary: { type: "string" },
                    recommendation: { type: "string" },
                    result: { type: "string" },
                },
                required: [
                    "technicalKnowledge",
                    "communication",
                    "problemSolving",
                    "confidence",
                    "behaviour",
                    "jdMatch",
                    "strengths",
                    "weaknesses",
                    "missingSkills",
                    "knowledgeGaps",
                    "redFlags",
                    "potential",
                    "hiringRisks",
                    "summary",
                    "recommendation",
                    "result",
                ],
            },
        },
    };

    const raw = await getAiResponse(
        "You evaluate hiring candidates using only the provided real interview transcript. Never fabricate dialogue or scores without transcript evidence.",
        prompt,
        model,
        0.2,
        evaluationSchema
    );

    const technicalKnowledge = scoreBlock(raw.technicalKnowledge);
    const communication = scoreBlock(raw.communication);
    const problemSolving = scoreBlock(raw.problemSolving);
    const confidence = scoreBlock(raw.confidence);
    const behaviour = scoreBlock(raw.behaviour);
    const jdMatch = scoreBlock(raw.jdMatch);

    const overallScore = computeOverallScore({
        technicalKnowledge,
        jdMatch,
        problemSolving,
        communication,
        behaviour,
    });

    const recommendation = deriveRecommendation(overallScore, raw.recommendation);
    const result = deriveResult(overallScore);

    let summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
    const wordCount = summary.split(/\s+/).filter(Boolean).length;
    if (wordCount > 250) {
        summary = summary.split(/\s+/).slice(0, 250).join(" ") + "…";
    }

    const evaluation = {
        // Canonical nested scorecard (evidence-based)
        technicalKnowledge,
        communication,
        problemSolving,
        confidence,
        behaviour,
        jdMatch,
        overallScore,
        strengths: stringList(raw.strengths),
        weaknesses: stringList(raw.weaknesses),
        missingSkills: stringList(raw.missingSkills),
        knowledgeGaps: stringList(raw.knowledgeGaps),
        redFlags: stringList(raw.redFlags),
        potential: stringList(raw.potential),
        hiringRisks: stringList(raw.hiringRisks),
        summary,
        recommendation,
        result,

        // Flat aliases for dashboard / legacy consumers
        technicalScore: technicalKnowledge.score,
        communicationScore: communication.score,
        behaviourScore: behaviour.score,
        problemSolvingScore: problemSolving.score,
        confidencePercent: confidence.score,
        jdMatchPercent: jdMatch.score,
        leadership: behaviour.score,

        weights: { ...SCORE_WEIGHTS },
        selectedThreshold: selectedThreshold(),
        source: "live-interview-transcript",
        evaluatedAt: new Date().toISOString(),
    };

    return { evaluation, result };
}

function formatEvaluationReportText(interview, evaluation) {
    const resume = interview.resumeSummary || {};
    const jd = interview.jobDescription || {};
    const lines = [
        "AI EVALUATION REPORT",
        "====================",
        "",
        "CANDIDATE DETAILS",
        `Name: ${interview.candidateName || resume.candidateName || "—"}`,
        `Email: ${interview.candidateEmail || resume.email || "—"}`,
        `Role Applied For: ${interview.jobRole || jd.jobTitle || resume.role || "—"}`,
        `Current Company: ${interview.currentCompany || resume.currentCompany || "—"}`,
        `Years of Experience: ${resume.yearsOfExperience || "—"}`,
        `Interview Date: ${interview.date || "—"} ${interview.time || ""}`.trim(),
        `Duration: ${
            interview.transcriptMeta?.duration != null
                ? `${Math.round(interview.transcriptMeta.duration / 60)} minutes`
                : `${interview.durationMinutes || "—"} minutes (scheduled)`
        }`,
        "",
        "RESUME SUMMARY",
        `Skills: ${Array.isArray(resume.skills) ? resume.skills.join(", ") : "—"}`,
        `Experience: ${resume.experience || resume.yearsOfExperience || "—"}`,
        `Strengths: ${Array.isArray(resume.strengths) ? resume.strengths.join("; ") : "—"}`,
        "",
        "JD SUMMARY",
        `Title: ${jd.jobTitle || "—"}`,
        `Domain: ${jd.domain || "—"}`,
        `Mandatory Skills: ${
            Array.isArray(jd.mandatorySkills) ? jd.mandatorySkills.join(", ") : "—"
        }`,
        `Description: ${jd.roleDescription || "—"}`,
        "",
        "INTERVIEW SCORES",
        `Technical Knowledge: ${evaluation.technicalKnowledge?.score ?? evaluation.technicalScore ?? "—"}`,
        `  Reason: ${evaluation.technicalKnowledge?.reason || "—"}`,
        `Communication: ${evaluation.communication?.score ?? evaluation.communicationScore ?? "—"}`,
        `  Reason: ${evaluation.communication?.reason || "—"}`,
        `Problem Solving: ${
            evaluation.problemSolving?.score ?? evaluation.problemSolvingScore ?? "—"
        }`,
        `  Reason: ${evaluation.problemSolving?.reason || "—"}`,
        `Confidence: ${evaluation.confidence?.score ?? evaluation.confidencePercent ?? "—"}`,
        `  Reason: ${evaluation.confidence?.reason || "—"}`,
        `Behaviour: ${evaluation.behaviour?.score ?? evaluation.behaviourScore ?? "—"}`,
        `  Reason: ${evaluation.behaviour?.reason || "—"}`,
        `JD Match: ${evaluation.jdMatch?.score ?? evaluation.jdMatchPercent ?? "—"}%`,
        `  Reason: ${evaluation.jdMatch?.reason || "—"}`,
        `Overall Score: ${evaluation.overallScore ?? "—"}`,
        "",
        "STRENGTHS",
        ...(evaluation.strengths?.length
            ? evaluation.strengths.map((s) => `- ${s}`)
            : ["- None listed"]),
        "",
        "WEAKNESSES",
        ...(evaluation.weaknesses?.length
            ? evaluation.weaknesses.map((s) => `- ${s}`)
            : ["- None listed"]),
        "",
        "MISSING SKILLS",
        ...(evaluation.missingSkills?.length
            ? evaluation.missingSkills.map((s) => `- ${s}`)
            : ["- None listed"]),
        "",
        "KNOWLEDGE GAPS",
        ...(evaluation.knowledgeGaps?.length
            ? evaluation.knowledgeGaps.map((s) => `- ${s}`)
            : ["- None listed"]),
        "",
        "RED FLAGS",
        ...(evaluation.redFlags?.length
            ? evaluation.redFlags.map((s) => `- ${s}`)
            : ["- None"]),
        "",
        "POTENTIAL",
        ...(evaluation.potential?.length
            ? evaluation.potential.map((s) => `- ${s}`)
            : ["- None listed"]),
        "",
        "HIRING RISKS",
        ...(evaluation.hiringRisks?.length
            ? evaluation.hiringRisks.map((s) => `- ${s}`)
            : ["- None listed"]),
        "",
        `Recommendation: ${evaluation.recommendation || "—"}`,
        `Result: ${evaluation.result || interview.result || "—"}`,
        "",
        "SUMMARY",
        evaluation.summary || "—",
        "",
        `Source: ${evaluation.source || "live-interview-transcript"}`,
        `Generated Time: ${evaluation.evaluatedAt || interview.resultGeneratedAt || "—"}`,
        `Evaluated At: ${evaluation.evaluatedAt || "—"}`,
    ];

    return lines.join("\n");
}

/**
 * Build PDF/TXT download for an existing evaluation on an interview.
 */
function getEvaluationDownloadBuffer(interview, format = "pdf") {
    const evaluation = interview?.evaluation;
    if (!evaluation) {
        const err = new Error("No AI evaluation available yet.");
        err.status = 404;
        err.stage = "voice-interview-evaluation";
        throw err;
    }

    const plainText = formatEvaluationReportText(interview, evaluation);
    const baseName = `${interview.id}_ai_evaluation`;

    if (String(format).toLowerCase() === "txt") {
        return {
            buffer: Buffer.from(plainText, "utf8"),
            contentType: "text/plain; charset=utf-8",
            filename: `${baseName}.txt`,
        };
    }

    return {
        buffer: buildSimplePdf("AI Evaluation Report", plainText),
        contentType: "application/pdf",
        filename: `${baseName}.pdf`,
    };
}

module.exports = {
    evaluateFromRealTranscript,
    getEvaluationDownloadBuffer,
    formatEvaluationReportText,
    computeOverallScore,
    deriveRecommendation,
    deriveResult,
    selectedThreshold,
    SCORE_WEIGHTS,
    RECOMMENDATIONS,
};
