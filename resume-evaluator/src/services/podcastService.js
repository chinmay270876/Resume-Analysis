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
        const SILENCE_MS = 300;
        const sampleRate = 24000;
        const silenceSamples = Math.floor((SILENCE_MS / 1000) * sampleRate);
        const silenceBuffer = Buffer.alloc(silenceSamples * 2, 0);

        const combinedParts = [];
        for (let i = 0; i < audioBuffers.length; i++) {
            combinedParts.push(audioBuffers[i]);
            if (i < audioBuffers.length - 1) {
                combinedParts.push(silenceBuffer);
            }
        }
        const combinedAudio = Buffer.concat(combinedParts);

        const suffix = uniqueSuffix ? `_${uniqueSuffix}` : "";
        const outputDirName = process.env.OUTPUT_DIR || "output";
        const podcastFilename = `podcast${suffix}.mp3`;
        const podcastPath = path.join(outputDir, podcastFilename);
        const podcastUrl = `/${outputDirName}/${podcastFilename}`;
        await fs.writeFile(podcastPath, combinedAudio);

        console.log(`✅ Podcast saved: ${podcastPath}`);
        return podcastUrl;
    } catch (error) {
        console.error("Podcast Generation Error:", error);
        throw error;
    }
}

module.exports = {
    generatePodcast,
};