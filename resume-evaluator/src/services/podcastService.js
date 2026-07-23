const { EdgeTTS } = require('node-edge-tts');
const fs = require('fs/promises');
const path = require('path');

// Map OpenAI voice names / standard speakers to Microsoft Edge Neural voices
const VOICE_MAP = {
    interviewer: 'en-US-GuyNeural', // Male interviewer voice
    candidate: 'en-US-AvaNeural',   // Female candidate voice
    alloy: 'en-US-GuyNeural',
    nova: 'en-US-AvaNeural',
};

/**
 * Synthesizes text into audio buffer via Microsoft Edge TTS
 */
async function getTTSBuffer(text, voiceName) {
    const selectedVoice = VOICE_MAP[voiceName.toLowerCase()] || 'en-US-AvaNeural';
    console.log(`🎤 Creating speech (${selectedVoice})`);

    try {
        const tts = new EdgeTTS({
            voice: selectedVoice,
            lang: 'en-US',
            outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        });

        // Generate speech audio buffer
        const { buffer } = await tts.synthesize(text, 'audio-24khz-48kbitrate-mono-mp3');
        console.log(`✅ Speech generated (${selectedVoice})`);
        return buffer;
    } catch (error) {
        console.error(`❌ Failed to generate speech for voice ${selectedVoice}:`, error);
        return null;
    }
}

/**
 * Generates combined MP3 audio for an entire transcript
 */
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

        console.log(`🎙️ Generating free local audio via Edge TTS...`);

        const audioBuffers = [];
        const concurrency = 5;

        // Process turns in parallel chunks to speed up synthesis
        for (let i = 0; i < turns.length; i += concurrency) {
            const chunk = turns.slice(i, i + concurrency);
            const chunkPromises = chunk.map((turn) => {
                const voiceKey = turn.speaker.toLowerCase() === "interviewer" ? "interviewer" : "candidate";
                return getTTSBuffer(turn.text, voiceKey);
            });

            const chunkResults = await Promise.all(chunkPromises);
            const validBuffers = chunkResults.filter(Buffer.isBuffer);
            if (validBuffers.length > 0) {
                audioBuffers.push(...validBuffers);
            }
        }

        if (audioBuffers.length === 0) {
            console.warn("⚠️ Audio generation failed for all chunks. Returning fallback URL.");
            const suffix = uniqueSuffix ? `_${uniqueSuffix}` : "";
            const outputDirName = process.env.OUTPUT_DIR || "output";
            return `/${outputDirName}/podcast${suffix}.mp3`;
        }

        console.log("🎵 Combining audio with silence padding...");

        // Prepare 300ms silence buffer at 24kHz 16-bit mono PCM (approximate MP3 silence padding)
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

        console.log(`✅ Podcast audio saved: ${podcastPath}`);
        return podcastUrl;
    } catch (error) {
        console.error("Podcast Generation Error:", error);
        throw error;
    }
}

module.exports = { generatePodcast };