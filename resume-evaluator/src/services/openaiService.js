const OpenAI = require("openai");

const DEFAULT_TIMEOUT = 60 * 1000;

let openai;

function getOpenAIClient() {
    if (!openai) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error("OPENAI_API_KEY is missing from .env");
        }
        const config = {
            apiKey,
            maxRetries: 2,
            timeout: DEFAULT_TIMEOUT,
        };
        if (process.env.OPENAI_BASE_URL) {
            config.baseURL = process.env.OPENAI_BASE_URL;
        }
        openai = new OpenAI(config);
    }
    return openai;
}

let hfClient;

function getHfClient() {
    if (!hfClient) {
        const apiKey = process.env.HF_TOKEN;
        if (!apiKey) {
            throw new Error("HF_TOKEN is missing from .env");
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
    const status = error?.status;
    const code = error?.code || error?.error?.code;
    const type = error?.type;

    if (type === "connection_error" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
        return true;
    }

    return (
        status === 401 ||
        status === 402 ||
        status === 429 ||
        status >= 500 ||
        code === "insufficient_quota" ||
        code === "invalid_api_key" ||
        code === "rate_limit_exceeded"
    );
}

function getHfResponseFormat(responseFormat) {
    if (!responseFormat) {
        return undefined;
    }

    if (responseFormat.type === "json_schema") {
        return { type: "json_object" };
    }

    return responseFormat;
}

/**
 * Shared helper to interact with OpenAI
 * @param {string} prompt - The system instructions
 * @param {string} userContent - The core user input/data
 * @param {string} model - Deployment model target
 * @param {number} temperature - Creativity setting
 * @param {object} responseFormat - Configuration for JSON schema or JSON mode
 */
async function getAiResponse(prompt, userContent, model, temperature, responseFormat = { type: "json_object" }) {
    let finalPrompt = prompt;
    if (responseFormat?.type === "json_object" && !prompt.toLowerCase().includes("json")) {
        finalPrompt += "\n\nNote: The response must be a valid JSON object.";
    }

    try {
        const client = getOpenAIClient();

        const response = await client.chat.completions.create({
            model: model,
            temperature: temperature,
            response_format: responseFormat,
            messages: [
                {
                    role: "system",
                    content: finalPrompt,
                },
                {
                    role: "user",
                    content: userContent,
                },
            ],
        });

        const content = response.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error("AI returned empty response.");
        }

        return content;
    } catch (error) {
        if (process.env.HF_TOKEN && shouldFallbackToHf(error)) {
            console.warn(`⚠️ OpenAI failed (${error.message}). Falling back to Hugging Face.`);
            try {
                const hfClient = getHfClient();
                const hfResponseFormat = getHfResponseFormat(responseFormat);
                const hfRequest = {
                    model: process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct:novita",
                    temperature: temperature,
                    messages: [
                        {
                            role: "system",
                            content: finalPrompt,
                        },
                        {
                            role: "user",
                            content: userContent,
                        },
                    ],
                };

                if (hfResponseFormat) {
                    hfRequest.response_format = hfResponseFormat;
                }

                const hfResponse = await hfClient.chat.completions.create(hfRequest);

                const content = hfResponse.choices?.[0]?.message?.content;
                if (!content) {
                    throw new Error("AI returned empty response from Hugging Face.");
                }

                console.log("✅ Hugging Face response");
                return content;
            } catch (hfError) {
                console.error("❌ Hugging Face fallback also failed:", hfError.message);
                throw new Error(`OpenAI failed: ${error.message}. Hugging Face fallback also failed: ${hfError.message}`);
            }
        }
        console.error("❌ AI Error:", error);
        throw error;
    }
}

/**
 * STEP 2: Extracts structured data from raw resume text
 */
async function analyzeResume(resumeText) {
    const prompt = `You are a professional HR recruiter and resume analyst. Extract structured data from the provided resume text with high accuracy.

EXTRACTION RULES - follow each rule exactly:

1. candidateName: The full name of the candidate. Look in the header/contact block first (often prefixed with "Candidate Name" or near the top). Extract the largest, most prominent name. If only a partial name appears, use the most complete name you can find.

2. email: The candidate's email address. Look near the top, often labelled "Email", next to an "@" icon, or within a contact line. An email ALWAYS contains "@" and a domain (e.g. name@example.com). Do NOT include mailto: links, LinkedIn URLs, or bracketed text unless it is a plain email.

3. phone: The candidate's phone number. Look for "Phone", "Mobile", or a number formatted like +1 555 123 4567 / +91 98201 22334. Include the country code if present. Do NOT include extensions.

4. currentCompany: The candidate's current or most recent company name. Look in the Experience section for the latest/most recent job entry. Extract the exact company name as written. Do NOT include previous companies or school names.

5. currentDesignation: The candidate's current or most recent job title. Look in the Experience section for the latest/most recent job entry. Extract the exact title as written (e.g. "Senior Software Engineer", "Product Manager"). Do NOT include the company name.

6. yearsOfExperience: Total years of professional experience as a string (e.g. "5" or "5+"). Calculate from the most recent employment start date if available, or from all employment durations. Look for explicit statements like "X years of experience" as a fallback. Empty string if absent.

7. skills: Extract all technical and professional skills from dedicated sections like "Skills", "Technical Skills", "Core Competencies", or tool lists. Return as an array of individual skill strings. Do NOT include generic terms like "Team Player" unless they are explicitly listed as skills.

8. strengths: Extract key strengths from sections like "Strengths", "Key Strengths", or positive self-assessment statements. Return as an array of strings. Do NOT include skills here.

9. weaknesses: Extract weaknesses or areas for improvement from sections like "Weaknesses", "Areas for Improvement", or balanced self-assessment. Return as an array of strings. If no weaknesses section exists, return an empty array.

GENERAL RULES:
- Search the ENTIRE text (header, footer, all sections) before concluding a value is missing.
- NEVER return the literal string "Not Provided", "N/A", "null", "none", "unknown", or similar placeholders. Only if a field is genuinely absent from the whole document, return an EMPTY STRING ("").
- Extract values verbatim. Do not invent, guess, or normalize contact details that are not in the text.
- LinkedIn URLs and other links are NOT the email or phone - keep them out of those fields.`;
    const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o";
    const temperature = 0.2;

    const strictSchema = {
        type: "json_schema",
        json_schema: {
            name: "resume_analysis",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    candidateName: {
                        type: "string",
                        description: "Full candidate name from the resume header/contact block. Empty string if truly absent - never 'Not Provided'."
                    },
                    email: {
                        type: "string",
                        description: "Candidate email address containing '@' and a domain. Empty string if truly absent - never 'Not Provided'."
                    },
                    phone: {
                        type: "string",
                        description: "Candidate phone number including country code if present. Empty string if truly absent - never 'Not Provided'."
                    },
                    skills: {
                        type: "array",
                        items: { type: "string" }
                    },
                    experience: { type: "string" },
                    currentCompany: {
                        type: "string",
                        description: "Candidate's current or most recent company name. Empty string if truly absent - never 'Not Provided'."
                    },
                    currentDesignation: {
                        type: "string",
                        description: "Candidate's current or most recent job title. Empty string if truly absent - never 'Not Provided'."
                    },
                    yearsOfExperience: {
                        type: "string",
                        description: "Total years of professional experience as a string (e.g. '5' or '5+'). Empty string if truly absent - never 'Not Provided'."
                    },
                    role: {
                        type: "string",
                        description: "The role/position the candidate is applying for, inferred from the resume. Empty string if truly absent."
                    },
                    interviewLevel: {
                        type: "string",
                        description: "Suggested interview seniority level (e.g. Junior, Mid-level, Senior, Lead). Empty string if truly absent."
                    },
                    strengths: {
                        type: "array",
                        items: { type: "string" }
                    },
                    weaknesses: {
                        type: "array",
                        items: { type: "string" }
                    }
                },
                required: ["candidateName", "email", "phone", "skills", "experience", "currentCompany", "currentDesignation", "yearsOfExperience", "role", "interviewLevel", "strengths", "weaknesses"],
                additionalProperties: false
            }
        }
    };

    console.log("-------------------------------------------------");
    console.log(`🚀 Starting Resume Analysis with ${model} (Structured Output)`);
    console.log("-------------------------------------------------");

    return await getAiResponse(prompt, resumeText, model, temperature, strictSchema);
}

/**
 * STEP 3: Generates an interview transcript with a strict speaker array schema
 */
async function generateInterview(analysisData) {
    const prompt = `You are an elite tech interviewer. Conduct a structured technical and behavioral interview based on the candidate's parsed resume. Generate the dialogue as a sequence of speaker interactions.`;
    const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o";
    const temperature = 0.7;

    const strictSchema = {
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

    console.log("-------------------------------------------------");
    console.log(`🚀 Generating Interview Transcript with ${model}`);
    console.log("-------------------------------------------------");

    return await getAiResponse(prompt, JSON.stringify(analysisData), model, temperature, strictSchema);
}

/**
 * STEP 8: Compiles a standardized evaluation scorecard based on the transcript
 */
async function evaluateCandidate(interviewTranscript) {
    const prompt = `You are a senior hiring manager. Read the interview transcript and evaluate the candidate across technical skills and communication. Provide scoring, structured feedback, and a clear recommendation.`;
    const model = process.env.OPENAI_ANALYSIS_MODEL || "gpt-4o";
    const temperature = 0.3;

    const strictSchema = {
        type: "json_schema",
        json_schema: {
            name: "candidate_evaluation",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    technicalScore: { type: "number", description: "Score out of 100" },
                    communicationScore: { type: "number", description: "Score out of 100" },
                    recommendation: { type: "string", enum: ["Recommended", "Selected", "Pass", "Rejected"] },
                    summaryNotes: { type: "string" }
                },
                required: ["technicalScore", "communicationScore", "recommendation", "summaryNotes"],
                additionalProperties: false
            }
        }
    };

    console.log("-------------------------------------------------");
    console.log(`📊 Starting Candidate Evaluation with ${model}`);
    console.log("-------------------------------------------------");

    return await getAiResponse(prompt, JSON.stringify(interviewTranscript, null, 2), model, temperature, strictSchema);
}

module.exports = {
    getOpenAIClient,
    getAiResponse,
    analyzeResume,
    generateInterview,
    evaluateCandidate
};