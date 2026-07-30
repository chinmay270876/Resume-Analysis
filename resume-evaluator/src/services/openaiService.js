const { OpenAI } = require("openai");
const { extractJsonFromText } = require("../utils/jsonUtils");

const DEFAULT_TIMEOUT = 60 * 1000;

let openai;

function getOpenAIClient() {
    if (!openai) {
        openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: DEFAULT_TIMEOUT,
            maxRetries: 2
        });
    }
    return openai;
}

/**
 * Shared helper to interact with LLMs (OpenAI)
 * Automatically strips markdown fences and parses JSON responses.
 */
async function getAiResponse(prompt, userContent, model, temperature, responseFormat = { type: "json_object" }) {
    let finalPrompt = prompt;

    if (responseFormat?.type === "json_object" && !prompt.toLowerCase().includes("json")) {
        finalPrompt += "\n\nNote: The response must be a valid JSON object strictly adhering to requested field structures.";
    }

    const targetModel = model || process.env.MODEL_NAME || "gpt-4o-mini";
    let rawContent = "";

    try {
        const client = getOpenAIClient();
        console.log("==================================");
        console.log("OpenAI model:", targetModel);
        console.log("==================================");

        const response = await client.chat.completions.create({
            model: targetModel,
            temperature: temperature,
            response_format: responseFormat,
            messages: [
                { role: "system", content: finalPrompt },
                { role: "user", content: typeof userContent === "string" ? userContent : JSON.stringify(userContent) },
            ],
        });

        rawContent = response.choices?.[0]?.message?.content;

        if (!rawContent) {
            throw new Error("AI returned an empty response.");
        }
    } catch (error) {
        console.error("❌ AI Error:", error);
        throw error;
    }

    // Safely strip markdown code blocks and parse JSON if expected
    if (responseFormat?.type === "json_object" || responseFormat?.type === "json_schema") {
        try {
            const cleanJson = rawContent
                .replace(/^```json\s*/i, "")
                .replace(/^```\s*/, "")
                .replace(/\s*```$/, "")
                .trim();
            return JSON.parse(cleanJson);
        } catch (parseErr) {
            const extracted = extractJsonFromText(rawContent);
            if (extracted) {
                try {
                    return JSON.parse(extracted);
                } catch (e) {
                    // Fallthrough
                }
            }
            console.warn("⚠️ Failed to parse JSON from AI response, returning raw string.");
            return rawContent;
        }
    }

    return rawContent;
}

/**
 * STEP 2: Extracts structured data from raw resume text
 */
async function analyzeResume(resumeText) {
    const prompt = `You are a professional HR recruiter and resume analyst. Extract structured data from the provided resume text with high accuracy.

Return a JSON object with the following keys:
- candidateName (string)
- email (string)
- phone (string)
- skills (array of strings)
- experience (string)
- currentCompany (string)
- currentDesignation (string)
- yearsOfExperience (string)
- role (string)
- interviewLevel (string)
- age (string)
- highestEducation (string)
- noticePeriod (string)
- location (string)
- numberOfCompaniesWorkedWith (number or string)
- certifications (array of strings)
- additional (string)
- strengths (array of strings)
- weaknesses (array of strings)

RULES:
- Search the ENTIRE text before concluding a value is missing.
- NEVER return placeholders like "Not Provided", "N/A", or "unknown". Return an EMPTY STRING ("") if genuinely absent.
- Extract values verbatim. Do not guess.`;

    const model = process.env.MODEL_NAME || "gpt-4o-mini";
    console.log("-------------------------------------------------");
    console.log(`🚀 Starting Resume Analysis with ${model}`);
    console.log("-------------------------------------------------");

    return await getAiResponse(prompt, resumeText, model, 0.2, { type: "json_object" });
}

/**
 * STEP 3: Generates an interview transcript
 */
async function generateInterview(analysisData) {
    const prompt = `You are an elite tech interviewer. Conduct a structured technical and behavioral interview based on the candidate's parsed resume. 

Return a JSON object with a single key "transcript", which is an array of objects representing dialogue turns:
{
  "transcript": [
    { "speaker": "Interviewer", "text": "..." },
    { "speaker": "Candidate", "text": "..." }
  ]
}`;

    const model = process.env.MODEL_NAME || "gpt-4o-mini";
    console.log("-------------------------------------------------");
    console.log(`🚀 Generating Interview Transcript with ${model}`);
    console.log("-------------------------------------------------");

    return await getAiResponse(prompt, analysisData, model, 0.7, { type: "json_object" });
}

/**
 * STEP 8: Compiles a standardized evaluation scorecard
 */
async function evaluateCandidate(interviewTranscript) {
    const prompt = `You are a senior hiring manager. Read the interview transcript and evaluate the candidate across technical skills and communication.

Return a JSON object with the following structure:
{
  "technicalScore": 85,
  "communicationScore": 90,
  "recommendation": "Recommended",
  "summaryNotes": "Detailed feedback summary here..."
}`;

    const model = process.env.MODEL_NAME || "gpt-4o-mini";
    console.log("-------------------------------------------------");
    console.log(`📊 Starting Candidate Evaluation with ${model}`);
    console.log("-------------------------------------------------");

    return await getAiResponse(prompt, interviewTranscript, model, 0.3, { type: "json_object" });
}

module.exports = {
    getOpenAIClient,
    getAiResponse,
    analyzeResume,
    generateInterview,
    evaluateCandidate,
};