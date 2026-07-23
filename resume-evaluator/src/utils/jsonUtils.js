/**
 * Extracts a JSON string from a larger text block.
 * Looks for a code block starting with ```json and ending with ```.
 *
 * @param {string} text The text containing the JSON block.
 * @returns {string | null} The extracted JSON string, or null if not found.
 */
function extractJsonFromText(text) {
    if (!text || typeof text !== "string") {
        return null;
    }

    const jsonRegex = /```(json)?\s*([\s\S]*?)\s*```/;
    const match = text.match(jsonRegex);

    if (match && match[2]) {
        return match[2].trim();
    }

    const trimmed = text.trim();

    try {
        JSON.parse(trimmed);
        return trimmed;
    } catch (e) {
        // Not valid JSON, try to repair common AI formatting issues
    }

    let repaired = trimmed;

    repaired = repaired.replace(/([^"\\])\s*,\s*([\]}])/g, '$1$2');

    try {
        JSON.parse(repaired);
        return repaired;
    } catch (e) {
        return null;
    }
}

module.exports = {
    extractJsonFromText
};