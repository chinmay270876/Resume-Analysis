const { extractPdfText } = require("./resumeParser");
const { getAiResponse } = require("./openaiService");

const MAX_JD_CHARS = 15000;

async function parseJobDescription(filePath) {
    const jdTextRaw = await extractPdfText(filePath);

    if (!jdTextRaw || jdTextRaw.trim().length === 0) {
        const err = new Error("Could not extract any text from the uploaded job description. The file may be empty, scanned/image-based, or corrupted.");
        err.status = 400;
        throw err;
    }

    const jdText = jdTextRaw.length > MAX_JD_CHARS
        ? jdTextRaw.substring(0, MAX_JD_CHARS)
        : jdTextRaw;

    const prompt = `You are a professional HR analyst. Extract structured requirements from the provided Job Description (JD) text with high accuracy.

Return a JSON object with these fields:
- jobTitle (string)
- mandatorySkills (array of strings — must-have skills explicitly required)
- preferredSkills (array of strings — nice-to-have or preferred skills)
- yearsOfExperience (string — required experience range or minimum)
- education (string — required or preferred education)
- certifications (array of strings — required or preferred certifications)
- domain (string — industry or domain focus)
- roleDescription (string — brief summary of the role responsibilities)
- projectRelevance (string — types of projects or experience emphasized in the JD)
- technicalRequirements (array of strings — specific technologies, tools, or platforms mentioned)

RULES:
- Search the ENTIRE text before concluding a value is missing.
- If a field cannot be found, return "" for strings or [] for arrays.
- NEVER return placeholders like "Not Provided", "N/A", or "Unknown".
- Extract values verbatim from the JD; do not invent requirements.`;

    const model = process.env.MODEL_NAME || "gpt-4o-mini";
    console.log("-------------------------------------------------");
    console.log(`📋 Starting Job Description parsing with ${model}`);
    console.log("-------------------------------------------------");

    const jdAnalysis = await getAiResponse(prompt, jdText, model, 0.2, { type: "json_object" });

    if (!jdAnalysis || typeof jdAnalysis !== "object") {
        const err = new Error("Invalid job description analysis response from AI.");
        err.status = 500;
        throw err;
    }

    return jdAnalysis;
}

module.exports = {
    parseJobDescription,
};
