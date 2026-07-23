const { OpenAI } = require("openai");

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

let hfClient;

function getHfClient() {
    if (!hfClient) {
        const apiKey = process.env.HF_TOKEN;
        if (!apiKey) {
            throw new Error("HF_TOKEN is missing from environment variables");
        }
        hfClient = new OpenAI({
            apiKey,
            baseURL: process.env.HF_BASE_URL || "https://router.huggingface.co/v1",
            timeout: DEFAULT_TIMEOUT,
        });
    }
    return hfClient;
}

function shouldFallbackToHf(error) {
    if (!error) return false;
    const status = error.status;
    const code = error.code || error.error?.code;
    const type = error.type;
    const name = error.name || error.constructor?.name || "";
    const msg = error.message || "";

    if (
        name.includes("Timeout") ||
        name.includes("Connection") ||
        msg.includes("timed out") ||
        msg.includes("Timeout") ||
        type === "connection_error" ||
        code === "ENOTFOUND" ||
        code === "ECONNREFUSED" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT"
    ) {
        return true;
    }

    return (
        status === 401 ||
        status === 402 ||
        status === 429 ||
        status >= 500 ||
        code === "insufficient_quota" ||
        code === "invalid_api_key" ||
        code === "rate_limit_exceeded" ||
        !status
    );
}

/**
 * Shared helper to interact with LLMs (OpenAI / HF)
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
        if (process.env.HF_TOKEN && shouldFallbackToHf(error)) {
            console.warn(`⚠️ Primary API failed (${error.message}). Falling back to Hugging Face.`);
            try {
                const hf = getHfClient();

                let hfResponseFormat = responseFormat;
                if (hfResponseFormat?.type === "json_schema") {
                    hfResponseFormat = { type: "text" };
                }

                const hfResponse = await hf.chat.completions.create({
                    model: process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct:novita",
                    temperature: temperature,
                    response_format: hfResponseFormat,
                    messages: [
                        { role: "system", content: finalPrompt },
                        { role: "user", content: typeof userContent === "string" ? userContent : JSON.stringify(userContent) },
                    ],
                });

                rawContent = hfResponse.choices?.[0]?.message?.content;
                if (!rawContent) {
                    throw new Error("AI returned empty response from Hugging Face.");
                }

                console.log("✅ Hugging Face response received");
            } catch (hfError) {
                console.error("❌ Hugging Face fallback also failed:", hfError.message);
                throw new Error(`Primary API failed: ${error.message}. Hugging Face fallback failed: ${hfError.message}`);
            }
        } else {
            console.error("❌ AI Error:", error);
            throw error;
        }
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
    getHfClient,
    getAiResponse,
    analyzeResume,
    generateInterview,
    evaluateCandidate,
};