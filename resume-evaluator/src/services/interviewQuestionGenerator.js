const { getAiResponse } = require("./openaiService");
const { extractJsonFromText } = require("../utils/jsonUtils");
const fs = require("fs").promises;
const path = require("path");

const templateCache = new Map();
const VALID_DIFFICULTIES = new Set(["Easy", "Medium", "Hard"]);

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

function toSkillList(value) {
    if (Array.isArray(value)) {
        return value.map((s) => String(s || "").trim().toLowerCase()).filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
        return value.split(/[,;|]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    }
    return [];
}

function computeMissingSkills(resumeAnalysis, jdAnalysis) {
    const candidateSkills = new Set([
        ...toSkillList(resumeAnalysis?.skills),
        ...toSkillList(resumeAnalysis?.strengths),
    ]);

    const required = [
        ...toSkillList(jdAnalysis?.mandatorySkills),
        ...toSkillList(jdAnalysis?.preferredSkills),
        ...toSkillList(jdAnalysis?.technicalRequirements),
    ];

    const missing = [];
    const seen = new Set();
    for (const skill of required) {
        if (seen.has(skill)) continue;
        seen.add(skill);

        let found = false;
        for (const owned of candidateSkills) {
            if (owned.includes(skill) || skill.includes(owned)) {
                found = true;
                break;
            }
        }
        if (!found) {
            missing.push(skill);
        }
    }
    return missing;
}

function normalizeDifficulty(value) {
    const raw = String(value || "").trim();
    if (VALID_DIFFICULTIES.has(raw)) return raw;
    const lower = raw.toLowerCase();
    if (lower.startsWith("e")) return "Easy";
    if (lower.startsWith("h")) return "Hard";
    return "Medium";
}

function normalizeQuestion(q, fallbackNo) {
    return {
        questionNo: Number(q?.questionNo) || fallbackNo,
        category: String(q?.category || "General").trim() || "General",
        difficulty: normalizeDifficulty(q?.difficulty),
        estimatedTime: String(q?.estimatedTime || "2 minutes").trim() || "2 minutes",
        question: String(q?.question || "").trim(),
        expectedAnswer: String(q?.expectedAnswer || "").trim(),
    };
}

function normalizeInterview(raw) {
    const sectionsIn = Array.isArray(raw?.sections) ? raw.sections : [];
    const sections = [];
    let questionNo = 1;

    for (const section of sectionsIn) {
        const sectionName = String(section?.sectionName || section?.name || "General").trim() || "General";
        const questionsIn = Array.isArray(section?.questions) ? section.questions : [];
        const questions = [];

        for (const q of questionsIn) {
            const normalized = normalizeQuestion(q, questionNo);
            if (!normalized.question) continue;
            normalized.questionNo = questionNo;
            questions.push(normalized);
            questionNo += 1;
        }

        if (questions.length > 0) {
            sections.push({ sectionName, questions });
        }
    }

    const totalQuestions = sections.reduce((sum, s) => sum + s.questions.length, 0);
    const interviewTitle = String(raw?.interviewTitle || "").trim()
        || "Structured Interview";
    const estimatedDuration = String(raw?.estimatedDuration || "").trim()
        || "25 minutes";

    return {
        interviewTitle,
        estimatedDuration,
        totalQuestions: Number(raw?.totalQuestions) || totalQuestions,
        sections,
    };
}

async function generateInterviewQuestions(resumeAnalysis, jdAnalysis) {
    if (!resumeAnalysis || typeof resumeAnalysis !== "object") {
        const err = new Error("Resume analysis is required to generate interview questions.");
        err.status = 400;
        err.stage = "generate-interview";
        throw err;
    }

    if (!jdAnalysis || typeof jdAnalysis !== "object") {
        const err = new Error("Job description analysis is required to generate interview questions.");
        err.status = 400;
        err.stage = "generate-interview";
        throw err;
    }

    try {
        const missingSkills = computeMissingSkills(resumeAnalysis, jdAnalysis);
        const promptTemplate = await getInterviewQuestionsPrompt();

        const prompt = promptTemplate
            .replace("{{resumeAnalysis}}", JSON.stringify(resumeAnalysis, null, 2))
            .replace("{{jdAnalysis}}", JSON.stringify(jdAnalysis, null, 2))
            .replace("{{missingSkills}}", JSON.stringify(missingSkills, null, 2));

        const candidateName = resumeAnalysis.candidateName || resumeAnalysis.name || "the candidate";
        const role = jdAnalysis.jobTitle || resumeAnalysis.role || "the target role";
        const level = resumeAnalysis.interviewLevel || "mid-level";
        const experience = resumeAnalysis.yearsOfExperience || resumeAnalysis.experience || "not specified";

        const systemMessage =
            `You are an expert technical interviewer designing a structured ~25-minute interview ` +
            `for ${candidateName} applying to ${role} (${level}). ` +
            `Candidate experience: ${experience}. ` +
            `Generate 20–30 personalized questions with expected answers. ` +
            `Focus on current/last project depth and JD skill match vs gaps. ` +
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
                                                expectedAnswer: { type: "string" },
                                            },
                                            required: [
                                                "questionNo",
                                                "category",
                                                "difficulty",
                                                "estimatedTime",
                                                "question",
                                                "expectedAnswer",
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

        console.log("======================================");
        console.log("RAW INTERVIEW QUESTIONS AI RESPONSE");
        console.log("======================================");
        console.log(typeof content === "string" ? content.slice(0, 2000) : JSON.stringify(content).slice(0, 2000));
        console.log("======================================");

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

        const interview = normalizeInterview(parsed);

        if (!interview.sections.length || interview.totalQuestions === 0) {
            const err = new Error("AI response did not contain any interview questions.");
            err.status = 502;
            err.stage = "generate-interview";
            throw err;
        }

        interview.totalQuestions = interview.sections.reduce(
            (sum, s) => sum + s.questions.length,
            0
        );

        console.log(
            `Successfully generated interview with ${interview.totalQuestions} questions ` +
            `across ${interview.sections.length} sections.`
        );

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
    computeMissingSkills,
};
