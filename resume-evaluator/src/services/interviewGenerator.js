const { getAiResponse } = require("./openaiService");
const { extractJsonFromText } = require("../utils/jsonUtils");
const fs = require("fs").promises;
const path = require("path");

const templateCache = new Map();

async function getInterviewPrompt() {
    if (templateCache.has("interview-prompt")) {
        return templateCache.get("interview-prompt");
    }
    const promptTemplate = await fs.readFile(
        path.join(process.cwd(), "templates", "interview-prompt.txt"),
        "utf-8"
    );
    templateCache.set("interview-prompt", promptTemplate);
    return promptTemplate;
}

function buildCandidateContext(analysis) {
    const clean = (v) => (typeof v === "string" ? v.trim() : (v ? String(v) : ""));
    const name = clean(analysis.candidateName) || clean(analysis.name) || "the candidate";
    const role = clean(analysis.role) || clean(analysis.roleTitle) || "the role they applied for";
    const level = clean(analysis.interviewLevel) || "mid-level";
    const experience = clean(analysis.experience) || "not specified";
    const skills = Array.isArray(analysis.skills) ? analysis.skills.filter(Boolean).join(", ") : "";
    const strengths = Array.isArray(analysis.strengths) ? analysis.strengths.filter(Boolean).join(", ") : "";
    return { name, role, level, experience, skills, strengths };
}

async function generateInterview(analysis) {
    try {
        const promptTemplate = await getInterviewPrompt();

        // Inject the ACTUAL candidate metadata so the model never falls back to
        // placeholder tokens such as "[Candidate Name]". Every downstream field
        // is replaced with the real extracted value before the OpenAI call.
        const ctx = buildCandidateContext(analysis);
        const interviewLevel = ctx.level;
        const role = ctx.role;

        const prompt = promptTemplate
            .replace("{{analysis}}", JSON.stringify(analysis, null, 2))
            .replace(/\[Candidate Name\]/gi, ctx.name)
            .replace(/\{\{candidateName\}\}/gi, ctx.name)
            .replace(/\{\{role\}\}/gi, role)
            .replace(/\{\{interviewLevel\}\}/gi, interviewLevel);

        const model = process.env.OPENAI_INTERVIEW_MODEL || "gpt-4o";

        // Define a strict JSON schema that guarantees the exact response structure
        const interviewSchema = {
            type: "json_schema",
            json_schema: {
                name: "interview_generation",
                strict: true,
                schema: {
                    type: "object",
                    properties: {
                        transcript: {
                            type: "array",
                            description: "The line-by-line interview dialogue script.",
                            items: {
                                type: "object",
                                properties: {
                                    speaker: { type: "string", enum: ["Interviewer", "Candidate"] },
                                    text: { type: "string" }
                                },
                                required: ["speaker", "text"],
                                additionalProperties: false
                            }
                        }
                    },
                    required: ["transcript"],
                    additionalProperties: false
                }
            }
        };

        // Pass real candidate context via the system message so the dialogue
        // uses the correct name, skills, experience, strengths, role and level.
        const systemMessage =
            `You are an expert technical interviewer conducting a ${interviewLevel} interview ` +
            `for the role of ${role}. The candidate's name is ${ctx.name}. ` +
            `Their experience: ${ctx.experience}. ` +
            (ctx.skills ? `Key skills: ${ctx.skills}. ` : "") +
            (ctx.strengths ? `Observed strengths: ${ctx.strengths}. ` : "") +
            `Always use the candidate's real name (${ctx.name}) in the dialogue. ` +
            `Never use placeholders like "[Candidate Name]", "Unknown Candidate", or "Not Provided".`;

        const content = await getAiResponse(
            systemMessage,
            prompt,
            model,
            0.5,
            interviewSchema // Pass the strict schema to enforce the structure
        );

        console.log("======================================");
        console.log("RAW INTERVIEW TRANSCRIPT AI RESPONSE");
        console.log("======================================");
        console.log(content);
        console.log("======================================");

        const jsonString = extractJsonFromText(content);
        if (!jsonString) {
            throw new Error("AI response did not contain valid JSON.");
        }
        const parsed = JSON.parse(jsonString);

        // Since we are using strict schemas, we are guaranteed to have a parsed.transcript array
        if (parsed && Array.isArray(parsed.transcript)) {
            console.log(`Successfully generated interview transcript with ${parsed.transcript.length} turns.`);
            return parsed.transcript;
        }

        // Fallback checks just in case of unexpected schema bypasses
        if (Array.isArray(parsed)) {
            return parsed;
        }

        throw new Error("AI response was valid JSON but did not contain a transcript array.");

    } catch (error) {
        console.error("Failed to generate interview transcript:", error);
        throw error;
    }
}

module.exports = {
    generateInterview,
};