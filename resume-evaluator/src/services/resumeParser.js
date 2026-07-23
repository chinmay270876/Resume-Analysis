const fs = require("fs").promises;
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const originalWarn = console.warn;
let warnOverrideDepth = 0;

function suppressPdfWarn() {
    warnOverrideDepth++;
    if (warnOverrideDepth === 1) {
        console.warn = (...args) => {
            const message = args.length ? String(args[0]) : "";
            if (/TT:\s*undefined function/i.test(message)) {
                console.debug("[pdf-parse] suppressed font warning:", message);
                return;
            }
            originalWarn.apply(console, args);
        };
    }
}

function restoreWarn() {
    warnOverrideDepth--;
    if (warnOverrideDepth === 0) {
        console.warn = originalWarn;
    }
}

// Reconstruct readable lines from raw text items.
// pdf.js returns text items in reading order but WITHOUT line breaks. The
// original code joined every item on a page with a single space, which
// collapsed a resume header such as:
//     Candidate Name
//     Jane Doe
//     Email
//     jane@example.com
// into one run-on line and destroyed the label -> value structure. GPT could
// then no longer reliably locate the candidate name / email / phone, which is
// exactly what produced the "Not Provided" analysis. Grouping items by their
// vertical position (y) restores the original line layout without throwing any
// text away, so extraction quality is preserved.
function itemsToText(items) {
    if (!items || items.length === 0) {
        return "";
    }

    const positioned = items
        .filter((item) => typeof item.str === "string")
        .map((item) => ({
            text: item.str,
            // pdf.js y grows upward; invert so the top of the page is first.
            y: item.transform ? -item.transform[5] : 0,
            hasEOL: Boolean(item.hasEOL),
        }));

    if (positioned.length === 0) {
        return "";
    }

    const lines = [];
    let current = [];
    let lastY = positioned[0].y;

    for (const item of positioned) {
        if (Math.abs(item.y - lastY) > 2 || item.hasEOL) {
            lines.push(current.join(" ").trim());
            current = [];
            lastY = item.y;
        }
        if (item.text.length > 0) {
            current.push(item.text);
        }
    }
    if (current.length > 0) {
        lines.push(current.join(" ").trim());
    }

    return lines
        .filter((line) => line.length > 0)
        .join("\n");
}

let pdfjsPromise = null;
async function getPdfJs() {
    if (!pdfjsPromise) {
        pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
    }
    return pdfjsPromise;
}

async function extractWithPdfJs(dataBuffer) {
    const pdfjs = await getPdfJs();

    const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(dataBuffer),
        useSystemFonts: true,
        disableFontFace: true,
    });

    const document = await loadingTask.promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const pageText = itemsToText(content.items);
        if (pageText) {
            pages.push(pageText);
        }
    }

    return pages.join("\n\n").trim();
}

// Normalize extracted text WITHOUT deleting content. We only collapse
// excessive blank lines so the AI prompt stays compact; nothing that could
// hold a candidate name / email / phone is removed.
function normalizeText(text) {
    return text
        .replace(/\r\n/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function extractPdfBuffer(dataBuffer) {
    suppressPdfWarn();

    let pdfParseError;
    try {
        const data = await pdfParse(dataBuffer);
        if (data.text?.trim()) {
            restoreWarn();
            return normalizeText(data.text);
        }
    } catch (error) {
        pdfParseError = error;
        console.warn("pdf-parse failed, will attempt pdfjs-dist fallback:", error.message);
    }

    let pdfJsError;
    try {
        const text = await extractWithPdfJs(dataBuffer);
        if (text) {
            restoreWarn();
            return normalizeText(text);
        }
    } catch (error) {
        pdfJsError = error;
        console.warn("pdfjs-dist fallback failed:", error.message);
    } finally {
        restoreWarn();
    }

    let message = "Could not extract text from this PDF.";
    if (pdfParseError) {
        message += `\n- pdf-parse: ${pdfParseError.message}`;
    }
    if (pdfJsError) {
        message += `\n- pdfjs-dist: ${pdfJsError.message}`;
    }
    throw new Error(message);
}

async function extractPdfText(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    let extractedText = "";

    try {
        const dataBuffer = await fs.readFile(filePath);

        if (ext === ".pdf") {
            extractedText = await extractPdfBuffer(dataBuffer);
        } else if (ext === ".docx") {
            const result = await mammoth.extractRawText({ buffer: dataBuffer });
            extractedText = result.value;
        } else {
            throw new Error("Unsupported file format");
        }

        if (!extractedText || extractedText.trim().length === 0) {
            console.warn("Resume parsing resulted in empty text.");
        } else {
            console.log(`✅ Resume Text Extracted. Length: ${extractedText.length}`);
            console.log(`   Preview: ${extractedText.substring(0, 1000)}...`);
        }

        return extractedText;
    } catch (error) {
        console.error("❌ Failed to extract text from resume:", error);
        throw error;
    }
}

module.exports = {
    extractPdfText,
};
