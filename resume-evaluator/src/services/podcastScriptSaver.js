const fs = require("fs").promises;
const path = require("path");

async function savePodcastScript(podcastScript, uniqueSuffix = "") {
    try {
        const outputDir = path.join(process.cwd(), process.env.OUTPUT_DIR || "output");
        await fs.mkdir(outputDir, { recursive: true });

        const suffix = uniqueSuffix ? `_${uniqueSuffix}` : "";
        const filePath = path.join(outputDir, `podcast-script${suffix}.txt`);

        await fs.writeFile(filePath, podcastScript, "utf8");

        return filePath;
    } catch (error) {
        console.error("Failed to save podcast script:", error);
        throw error;
    }
}

module.exports = {
    savePodcastScript,
};
