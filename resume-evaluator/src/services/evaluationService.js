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

async function evaluateCandidate(interviewText) {
    try {
        const promptTemplate = await getEvaluationPrompt();

        const prompt = promptTemplate.replace("{{interviewText}}", JSON.stringify(interviewText, null, 2));

        const model = process.env.OPENAI_EVALUATION_MODEL || "gpt-4o";
        const temperature = 0.2;

        // Match the exact naming convention your frontend uses: score, skills, strengths, weaknesses, result.
        // Keep overallScore and recommendation for backward-compatible internal usage (Excel report + email).
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
                        }
                    },
                    required: [
                        "score",
                        "overallScore",
                        "skills",
                        "strengths",
                        "weaknesses",
                        "result",
                        "recommendation"
                    ],
                    additionalProperties: false
                }
            }
        };

        // Return the RAW string so the controller can log and parse it consistently with analyzeResume.
        const content = await getAiResponse(
            "You are an AI evaluation engine. Read the interview text and evaluate the candidate.",
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