const { getOpenAIClient } = require("./openaiService");
const fs = require("fs").promises;
const path = require("path");

async function getTTSBuffer(text, voice) {
    console.log(`🎤 Creating speech (${voice})`);
    try {
        const client = getOpenAIClient();
        const speech = await client.audio.speech.create({
            model: process.env.OPENAI_TTS_MODEL || "tts-1",
            voice,
            input: text,
        });
        console.log(`✅ Speech generated (${voice})`);
        return Buffer.from(await speech.arrayBuffer());
    } catch (error) {
        console.error(`❌ Failed to generate speech for voice ${voice}:`, error);
        throw error;
    }
}

async function generatePodcast(transcriptTurns, uniqueSuffix = "") {
    try {
        if (!transcriptTurns || transcriptTurns.length === 0) {
            throw new Error("Transcript is empty");
        }

        const outputDir = path.join(process.cwd(), process.env.OUTPUT_DIR || "output");
        await fs.mkdir(outputDir, { recursive: true });

        const turns = transcriptTurns.filter((turn) => turn.speaker && turn.text);
        console.log(`🎙 Found ${turns.length} turns`);

        if (turns.length === 0) {
            throw new Error("No valid speaker turns found.");
        }

        console.log(`🎙️ Generating audio in parallel...`);

        const audioBuffers = [];
        const concurrency = 3;
        for (let i = 0; i < turns.length; i += concurrency) {
            const chunk = turns.slice(i, i + concurrency);
            const chunkPromises = chunk.map((turn) => {
                const voice = turn.speaker.toLowerCase() === "interviewer" ? "alloy" : "nova";
                return getTTSBuffer(turn.text, voice);
            });
            const chunkResults = await Promise.all(chunkPromises);
            audioBuffers.push(...chunkResults);
        }

        console.log("🎵 Combining audio...");
        const combinedAudio = Buffer.concat(audioBuffers);

        const suffix = uniqueSuffix ? `_${uniqueSuffix}` : "";
        const podcastPath = path.join(outputDir, `podcast${suffix}.mp3`);
        await fs.writeFile(podcastPath, combinedAudio);

        console.log(`✅ Podcast saved: ${podcastPath}`);
        return podcastPath;
    } catch (error) {
        console.error("Podcast Generation Error:", error);
        throw error;
    }
}

module.exports = {
    generatePodcast,
};