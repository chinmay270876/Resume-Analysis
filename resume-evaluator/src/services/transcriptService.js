const fsp = require("fs").promises;
const path = require("path");
const { setLastTranscript } = require("../utils/lastReportStore");

async function saveTranscript(
    transcriptTurns,
    candidateName = "Unknown_Candidate",
    uniqueSuffix = ""
) {
    try {
        // Phase 5: never let a missing/empty name crash file generation.
        const safeName =
            (typeof candidateName === "string" && candidateName.trim()) ||
            "Unknown_Candidate";

        if (!transcriptTurns || transcriptTurns.length === 0) {
            throw new Error("Transcript is empty");
        }

        const outputDir = path.join(process.cwd(), process.env.REPORT_DIR || "results");
        await fsp.mkdir(outputDir, { recursive: true });

        const safeFileName = safeName
            .replace(/[<>:"/\\|?*]/g, "")
            .replace(/\s+/g, "_");

        const suffix = uniqueSuffix ? `_${uniqueSuffix}` : "";
        const fileName = `${safeFileName}${suffix}_transcript.txt`;
        const filePath = path.join(outputDir, fileName);

        console.log("Saving transcript to:", filePath);

        const transcriptText = transcriptTurns
            .map((turn) => `${turn.speaker}: ${turn.text}`)
            .join("\n\n");

        await fsp.writeFile(filePath, transcriptText, "utf8");

        console.log("Transcript saved successfully");

        setLastTranscript(fileName);

        return fileName;
    } catch (error) {
        console.error("Transcript Save Error:", error);
        throw error;
    }
}

module.exports = {
    saveTranscript,
};