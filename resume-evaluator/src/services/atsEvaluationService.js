const { getAiResponse } = require("../services/openaiService");

function getGrade(score) {
    if (score === null || score === undefined) return "";
    if (score >= 95) return "A+";
    if (score >= 90) return "A";
    if (score >= 80) return "B";
    if (score >= 70) return "C";
    if (score >= 60) return "D";
    return "F";
}

async function evaluateAts(resumeText, analysis) {
    const startTime = Date.now();
    console.log("=================================================");
    console.log("🔍 ATS Evaluation Started");
    console.log("=================================================");

    try {
        const prompt = `You are an ATS (Applicant Tracking System) compatibility expert. Analyze the provided resume text against modern ATS best practices and hiring standards.

Return a JSON object with the following structure:
{
  "atsScore": 85,
  "atsBreakdown": {
    "contactInformation": 8,
    "resumeStructure": 12,
    "skills": 13,
    "experience": 14,
    "education": 8,
    "keywordOptimization": 22,
    "formatting": 8
  },
  "missingKeywords": ["keyword1", "keyword2"],
  "formatIssues": ["Issue 1", "Issue 2"],
  "recommendations": ["Recommendation 1", "Recommendation 2"],
  "atsSummary": "Brief summary of ATS compatibility."
}

SCORING RUBRIC (Total 100):
- Contact Information (10): Email, phone, location clearly present and properly formatted
- Resume Structure (15): Clear section headings, logical flow, proper organization
- Skills (15): Relevant skills listed, technical keywords present, measurable proficiency
- Experience (15): Work history with dates, achievements, quantifiable results
- Education (10): Degree, institution, graduation year present
- Keyword Optimization (25): Industry keywords, job title alignment, action verbs, measurable achievements
- Formatting (10): Clean format, standard fonts, no tables/graphics, ATS-friendly layout

RULES:
- Score each category from 0 to its maximum points based on the rubric above
- missingKeywords should list specific important keywords or skills MISSING from the resume that are relevant to the role
- formatIssues should list specific formatting problems that would hurt ATS parsing (e.g., "Uses tables for layout", "Missing standard section headings", "Headers are images")
- recommendations should be 3-5 actionable improvement suggestions
- atsSummary should be 1-2 sentences summarizing overall ATS compatibility
- Be strict but fair in scoring`;

        const model = process.env.MODEL_NAME || "gpt-4o-mini";

        const atsSchema = {
            type: "json_schema",
            json_schema: {
                name: "ats_evaluation",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        atsScore: {
                            type: "number",
                            description: "Overall ATS compatibility score out of 100."
                        },
                        atsBreakdown: {
                            type: "object",
                            description: "Weighted ATS scoring breakdown out of 100 total.",
                            additionalProperties: false,
                            properties: {
                                contactInformation: { type: "number", description: "Contact info score (0-10)" },
                                resumeStructure: { type: "number", description: "Resume structure score (0-15)" },
                                skills: { type: "number", description: "Skills score (0-15)" },
                                experience: { type: "number", description: "Experience score (0-15)" },
                                education: { type: "number", description: "Education score (0-10)" },
                                keywordOptimization: { type: "number", description: "Keyword optimization score (0-25)" },
                                formatting: { type: "number", description: "Formatting score (0-10)" }
                            },
                            required: ["contactInformation", "resumeStructure", "skills", "experience", "education", "keywordOptimization", "formatting"]
                        },
                        missingKeywords: {
                            type: "array",
                            items: { type: "string" },
                            description: "Important keywords missing from the resume."
                        },
                        formatIssues: {
                            type: "array",
                            items: { type: "string" },
                            description: "Formatting issues that hurt ATS parsing."
                        },
                        recommendations: {
                            type: "array",
                            items: { type: "string" },
                            description: "Actionable recommendations to improve ATS compatibility."
                        },
                        atsSummary: {
                            type: "string",
                            description: "Brief summary of ATS compatibility."
                        }
                    },
                    required: ["atsScore", "atsBreakdown", "missingKeywords", "formatIssues", "recommendations", "atsSummary"],
                    additionalProperties: false
                }
            }
        };

        const content = await getAiResponse(
            "You are an ATS compatibility expert. Analyze the resume text and return a structured JSON evaluation.",
            resumeText,
            model,
            0.2,
            atsSchema
        );

        if (!content || typeof content !== "object") {
            throw new Error("Invalid ATS evaluation response from AI.");
        }

        const score = typeof content.atsScore === "number" ? content.atsScore : null;

        const result = {
            atsScore: score,
            atsGrade: getGrade(score),
            atsSummary: typeof content.atsSummary === "string" ? content.atsSummary : "",
            atsBreakdown: content.atsBreakdown || {},
            missingKeywords: Array.isArray(content.missingKeywords) ? content.missingKeywords : [],
            formatIssues: Array.isArray(content.formatIssues) ? content.formatIssues : [],
            recommendations: Array.isArray(content.recommendations) ? content.recommendations : []
        };

        const timeTaken = Math.round((Date.now() - startTime) / 100) / 100;
        console.log("✅ ATS Evaluation Completed");
        console.log(`ATS Score: ${result.atsScore}`);
        console.log(`ATS Grade: ${result.atsGrade}`);
        console.log(`Time Taken: ${timeTaken}s`);
        console.log("=================================================");

        return result;

    } catch (error) {
        const timeTaken = Math.round((Date.now() - startTime) / 100) / 100;
        console.error("❌ ATS Evaluation Error:", error.message);
        console.log(`ATS Evaluation Failed after ${timeTaken}s`);
        console.log("=================================================");
        throw error;
    }
}

module.exports = {
    evaluateAts,
    getGrade
};
