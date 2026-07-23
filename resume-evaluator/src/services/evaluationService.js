const { getAiResponse } = require("./openaiService");
const fs = require("fs").promises;
const path = require("path");

const templateCache = new Map();

async function getEvaluationPrompt() {
    if (templateCache.has("evaluation-prompt")) {
        return templateCache.get("evaluation-prompt");
    }
    const promptTemplate = await fs.readFile(
        path.join(process.cwd(), "templates", "evaluation-prompt.txt"),
        "utf-8"
    );
    templateCache.set("evaluation-prompt", promptTemplate);
    return promptTemplate;
}

async function evaluateCandidate(interviewText, analysis) {
    try {
        const promptTemplate = await getEvaluationPrompt();

        const resumeAnalysisJson = analysis ? JSON.stringify(analysis, null, 2) : "Not provided.";
        const prompt = promptTemplate
            .replace("{{interviewText}}", JSON.stringify(interviewText, null, 2))
            .replace("{{resumeAnalysis}}", resumeAnalysisJson);

        const model = process.env.OPENAI_EVALUATION_MODEL || process.env.MODEL_NAME || "llama3.2";
        const temperature = 0.2;

        const evaluationSchema = {
            type: "json_schema",
            json_schema: {
                name: "candidate_evaluation",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        score: {
                            type: "number",
                            description: "Overall candidate evaluation score out of 100."
                        },
                        overallScore: {
                            type: "number",
                            description: "Alias of score, kept for internal compatibility."
                        },
                        scoreBreakdown: {
                            type: "object",
                            description: "Weighted scoring breakdown out of 100 total.",
                            additionalProperties: false,
                            properties: {
                                experience: { type: "number", description: "Experience score (0-25)" },
                                technicalSkills: { type: "number", description: "Technical skills score (0-25)" },
                                projects: { type: "number", description: "Projects score (0-10)" },
                                education: { type: "number", description: "Education score (0-10)" },
                                certifications: { type: "number", description: "Certifications score (0-5)" },
                                communication: { type: "number", description: "Communication score (0-10)" },
                                resumeQuality: { type: "number", description: "Resume quality score (0-5)" },
                                leadership: { type: "number", description: "Leadership score (0-10)" }
                            },
                            required: ["experience", "technicalSkills", "projects", "education", "certifications", "communication", "resumeQuality", "leadership"]
                        },
                        skills: {
                            type: "array",
                            items: { type: "string" },
                            description: "Key technical skills demonstrated in the interview."
                        },
                        strengths: {
                            type: "array",
                            items: { type: "string" },
                            description: "Candidate strengths observed during the interview."
                        },
                        weaknesses: {
                            type: "array",
                            items: { type: "string" },
                            description: "Areas where the candidate needs improvement."
                        },
                        result: {
                            type: "string",
                            description: "Final outcome status, e.g., PASS or FAIL."
                        },
                        recommendation: {
                            type: "string",
                            description: "Final recommendation status, e.g., Recommended or Rejected."
                        },
                        reasoning: {
                            type: "string",
                            description: "Brief explanation of the score assignment."
                        },
                        selected: {
                            type: "boolean",
                            description: "Whether the candidate is selected for the role."
                        }
                    },
                    required: [
                        "score",
                        "overallScore",
                        "scoreBreakdown",
                        "skills",
                        "strengths",
                        "weaknesses",
                        "result",
                        "recommendation",
                        "reasoning",
                        "selected"
                    ],
                    additionalProperties: false
                }
            }
        };

        const content = await getAiResponse(
            "You are an AI evaluation engine. Read the interview text and resume analysis, then evaluate the candidate holistically using the weighted scoring rubric.",
            prompt,
            model,
            temperature,
            evaluationSchema
        );

        return content;

    } catch (error) {
        console.error("Evaluation Service Error:", error);
        throw error;
    }
}

module.exports = {
    evaluateCandidate,
};