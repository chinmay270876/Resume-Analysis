const { getAiResponse } = require("./openaiService");
const { extractJsonFromText } = require("../utils/jsonUtils");
const fs = require("fs").promises;
const path = require("path");

const templateCache = new Map();
const VALID_DIFFICULTIES = new Set(["Easy", "Medium", "Hard"]);
const MAX_INTERVIEW_QUESTIONS = 10;

const CANONICAL_SECTIONS = [
    "Introduction",
    "Current Project",
    "JD Technical Questions",
    "Resume + JD Combined",
    "Behavioural",
    "Closing",
];

async function getInterviewQuestionsPrompt() {
    if (templateCache.has("interview-questions-prompt")) {
        return templateCache.get("interview-questions-prompt");
    }
    const promptTemplate = await fs.readFile(
        path.join(process.cwd(), "templates", "interview-questions-prompt.txt"),
        "utf-8"
    );
    templateCache.set("interview-questions-prompt", promptTemplate);
    return promptTemplate;
}

function normalizeDifficulty(value) {
    const raw = String(value || "").trim();
    if (VALID_DIFFICULTIES.has(raw)) return raw;
    const lower = raw.toLowerCase();
    if (lower.startsWith("e")) return "Easy";
    if (lower.startsWith("h")) return "Hard";
    return "Medium";
}

function buildResumeContext(resumeAnalysis) {
    if (!resumeAnalysis || typeof resumeAnalysis !== "object") {
        return "Not provided. Generate a JD-focused interview plan. Keep Current Project and Resume + JD Combined sections role-generic — do not invent employers, project names, or candidate details.";
    }

    const context = {
        candidateName: resumeAnalysis.candidateName || resumeAnalysis.name || "",
        email: resumeAnalysis.email || "",
        currentCompany: resumeAnalysis.currentCompany || "",
        currentDesignation: resumeAnalysis.currentDesignation || "",
        yearsOfExperience: resumeAnalysis.yearsOfExperience || "",
        role: resumeAnalysis.role || resumeAnalysis.roleTitle || "",
        skills: Array.isArray(resumeAnalysis.skills) ? resumeAnalysis.skills : [],
        experience: resumeAnalysis.experience || "",
        certifications: Array.isArray(resumeAnalysis.certifications)
            ? resumeAnalysis.certifications
            : [],
        highestEducation: resumeAnalysis.highestEducation || "",
        strengths: Array.isArray(resumeAnalysis.strengths) ? resumeAnalysis.strengths : [],
        weaknesses: Array.isArray(resumeAnalysis.weaknesses) ? resumeAnalysis.weaknesses : [],
        location: resumeAnalysis.location || "",
        additional: resumeAnalysis.additional || "",
    };

    return JSON.stringify(context, null, 2);
}

function normalizeQuestion(q, fallbackNo) {
    const questionText = Array.isArray(q)
        ? ""
        : String(q?.question || (typeof q === "string" ? q : "")).trim();

    return {
        questionNo: Number(q?.questionNo) || fallbackNo,
        category: String(q?.category || "General").trim() || "General",
        difficulty: normalizeDifficulty(q?.difficulty),
        estimatedTime: String(q?.estimatedTime || "2 minutes").trim() || "2 minutes",
        question: questionText,
        // Kept for backward compatibility with previously stored interviews; new plans omit answers.
        expectedAnswer: String(q?.expectedAnswer || "").trim(),
    };
}

function normalizeSectionName(raw) {
    const name = String(raw || "").trim();
    if (!name) return "General";

    const lower = name.toLowerCase();
    if (lower.includes("intro")) return "Introduction";
    if (
        lower.includes("combined") ||
        (lower.includes("resume") && lower.includes("jd")) ||
        lower.includes("gap")
    ) {
        return "Resume + JD Combined";
    }
    if (lower.includes("technical") || lower.includes("jd tech")) return "JD Technical Questions";
    if (lower.includes("current") || lower.includes("latest project") || lower === "project" || lower.includes("current project")) {
        return "Current Project";
    }
    if (lower.includes("behav") || lower.includes("behaviour") || lower.includes("soft")) {
        return "Behavioural";
    }
    if (lower.includes("clos")) return "Closing";
    return name;
}

function normalizeInterview(raw, jdAnalysis) {
    const sectionsIn = Array.isArray(raw?.sections) ? raw.sections : [];
    const sections = [];
    let questionNo = 1;

    for (const section of sectionsIn) {
        const sectionName = normalizeSectionName(
            section?.sectionName || section?.title || section?.name || "General"
        );
        const questionsIn = Array.isArray(section?.questions) ? section.questions : [];
        const questions = [];

        for (const q of questionsIn) {
            const normalized = normalizeQuestion(q, questionNo);
            if (!normalized.question) continue;
            // Strip any answer content — this page is questions-only.
            normalized.expectedAnswer = "";
            normalized.questionNo = questionNo;
            questions.push(normalized);
            questionNo += 1;
        }

        if (questions.length > 0) {
            sections.push({ sectionName, questions });
        }
    }

    // Prefer canonical section order when names match.
    sections.sort((a, b) => {
        const ai = CANONICAL_SECTIONS.indexOf(a.sectionName);
        const bi = CANONICAL_SECTIONS.indexOf(b.sectionName);
        const aOrder = ai === -1 ? 999 : ai;
        const bOrder = bi === -1 ? 999 : bi;
        return aOrder - bOrder;
    });

    // Hard cap so the live interview never exceeds MAX_INTERVIEW_QUESTIONS.
    let remaining = MAX_INTERVIEW_QUESTIONS;
    for (let i = 0; i < sections.length; i += 1) {
        if (remaining <= 0) {
            sections.splice(i);
            break;
        }
        if (sections[i].questions.length > remaining) {
            sections[i].questions = sections[i].questions.slice(0, remaining);
        }
        remaining -= sections[i].questions.length;
    }

    // Re-number after sort so questionNo stays sequential in display order.
    let renumber = 1;
    for (const section of sections) {
        for (const q of section.questions) {
            q.questionNo = renumber;
            renumber += 1;
        }
    }

    const totalQuestions = sections.reduce((sum, s) => sum + s.questions.length, 0);
    const role = String(jdAnalysis?.jobTitle || "").trim();
    const fallbackTitle = role ? `${role} Interview` : "Structured Interview";
    let interviewTitle = String(raw?.interviewTitle || "").trim() || fallbackTitle;

    // Ensure titles stay role-based (strip trailing " for {Candidate Name}" if the model adds it)
    interviewTitle = interviewTitle.replace(/\s+for\s+.+$/i, "").trim() || fallbackTitle;

    const estimatedDuration = String(raw?.estimatedDuration || "").trim()
        || "25 minutes";

    return {
        interviewTitle,
        estimatedDuration,
        totalQuestions,
        sections,
    };
}

/**
 * Generate a JD-primary interview question plan, personalized with optional resume analysis.
 * @param {object} jdAnalysis
 * @param {object|null} [resumeAnalysis]
 */
async function generateInterviewQuestions(jdAnalysis, resumeAnalysis = null) {
    // Legacy callers accidentally used (resume, jd). Detect and correct.
    if (
        arguments.length >= 2 &&
        arguments[0] &&
        typeof arguments[0] === "object" &&
        arguments[1] &&
        typeof arguments[1] === "object" &&
        !jdAnalysis?.jobTitle &&
        arguments[1]?.jobTitle
    ) {
        resumeAnalysis = arguments[0];
        jdAnalysis = arguments[1];
    }

    if (!jdAnalysis || typeof jdAnalysis !== "object") {
        const err = new Error("Job description analysis is required to generate interview questions.");
        err.status = 400;
        err.stage = "generate-interview";
        throw err;
    }

    try {
        const promptTemplate = await getInterviewQuestionsPrompt();
        const resumeContext = buildResumeContext(resumeAnalysis);

        const prompt = promptTemplate
            .replace("{{jdAnalysis}}", JSON.stringify(jdAnalysis, null, 2))
            .replace("{{resumeAnalysis}}", resumeContext);

        const role = jdAnalysis.jobTitle || "the target role";
        const level = jdAnalysis.seniority || jdAnalysis.experienceLevel || "mid-level";
        const hasResume = Boolean(resumeAnalysis && typeof resumeAnalysis === "object");

        const systemMessage =
            `You are an expert technical interviewer designing the interview plan for an AI Interview Bot. ` +
            `Generate exactly 10 high-value technical and situational interview questions tailored to the candidate's resume and job role. ` +
            `Create a focused interview for the ${role} role (${level}) with exactly ${MAX_INTERVIEW_QUESTIONS} questions — no more, no fewer. ` +
            `Priority: (1) Job Description ~70–80%, (2) personalize from the candidate resume` +
            `${hasResume ? "" : " (resume not provided — stay JD-focused)"}, ` +
            `(3) probe Resume vs JD skill gaps. ` +
            `Do NOT generate answers, transcripts, evaluations, or hire/reject decisions. ` +
            `Return only the required JSON structure.`;

        const interviewSchema = {
            type: "json_schema",
            json_schema: {
                name: "interview_question_bank",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        interviewTitle: { type: "string" },
                        estimatedDuration: { type: "string" },
                        totalQuestions: { type: "number" },
                        sections: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    sectionName: { type: "string" },
                                    questions: {
                                        type: "array",
                                        items: {
                                            type: "object",
                                            properties: {
                                                questionNo: { type: "number" },
                                                category: { type: "string" },
                                                difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] },
                                                estimatedTime: { type: "string" },
                                                question: { type: "string" },
                                            },
                                            required: [
                                                "questionNo",
                                                "category",
                                                "difficulty",
                                                "estimatedTime",
                                                "question",
                                            ],
                                            additionalProperties: false,
                                        },
                                    },
                                },
                                required: ["sectionName", "questions"],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ["interviewTitle", "estimatedDuration", "totalQuestions", "sections"],
                    additionalProperties: false,
                },
            },
        };

        const model = process.env.OPENAI_INTERVIEW_MODEL || process.env.MODEL_NAME || "gpt-4o-mini";

        const content = await getAiResponse(
            systemMessage,
            prompt,
            model,
            0.4,
            interviewSchema
        );

        if (process.env.NODE_ENV !== "production") {
            console.log("======================================");
            console.log("RAW INTERVIEW QUESTIONS AI RESPONSE");
            console.log("======================================");
            console.log(typeof content === "string" ? content.slice(0, 500) : JSON.stringify(content).slice(0, 500));
            console.log("======================================");
        }

        let parsed = content;
        if (typeof content === "string") {
            const jsonString = extractJsonFromText(content) || content;
            try {
                parsed = JSON.parse(jsonString);
            } catch (e) {
                console.error("Failed to parse interview questions AI response:", e.message);
                const err = new Error("AI returned an unparseable interview response.");
                err.status = 502;
                err.stage = "generate-interview";
                throw err;
            }
        }

        const interview = normalizeInterview(parsed, jdAnalysis);

        if (!interview.sections.length || interview.totalQuestions === 0) {
            const err = new Error("AI response did not contain any interview questions.");
            err.status = 502;
            err.stage = "generate-interview";
            throw err;
        }

        interview.totalQuestions = Math.min(
            interview.sections.reduce((sum, s) => sum + s.questions.length, 0),
            MAX_INTERVIEW_QUESTIONS
        );

        if (process.env.NODE_ENV !== "production") {
            console.log(
                `Successfully generated interview with ${interview.totalQuestions} questions ` +
                `across ${interview.sections.length} sections` +
                `${hasResume ? " (JD + resume personalized)" : " (JD-only)"}.`
            );
        }

        return interview;
    } catch (error) {
        if (!error.stage) {
            error.stage = "generate-interview";
        }
        if (!error.status && !error.statusCode) {
            error.status = 502;
        }
        console.error("Failed to generate interview questions:", error.message || error);
        throw error;
    }
}

module.exports = {
    generateInterviewQuestions,
    MAX_INTERVIEW_QUESTIONS,
};
