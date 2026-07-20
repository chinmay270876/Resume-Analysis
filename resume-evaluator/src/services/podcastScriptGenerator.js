const { getAiResponse } = require("./openaiService");
const fs = require("fs").promises;
const path = require("path");

let cachedPromptTemplate = null;

async function getPromptTemplate() {
    if (!cachedPromptTemplate) {
        cachedPromptTemplate = await fs.readFile(
            path.join(process.cwd(), "templates", "podcast-script-prompt.txt"),
            "utf-8"
        );
    }
    return cachedPromptTemplate;
}

async function generatePodcastScript(interviewTranscript) {
    try {
        const promptTemplate = await getPromptTemplate();

        const prompt = promptTemplate.replace(
            "{{interviewTranscript}}",
            JSON.stringify(interviewTranscript)
        );

        const model = process.env.OPENAI_PODCAST_SCRIPT_MODEL || "gpt-4o";

        const content = await getAiResponse(
            "You are a podcast script writer.",
            prompt,
            model,
            0.7,
            { type: "text" }
        );

        return content;
    } catch (error) {
        console.error("Failed to generate podcast script:", error);
        throw error;
    }
}

module.exports = {
    generatePodcastScript,
};
