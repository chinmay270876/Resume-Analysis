const fs = require("fs").promises;
const path = require("path");

/**
 * Validates uploaded resume content by magic bytes (not just extension).
 * PDF must start with %PDF; DOCX must be a ZIP (PK). Throws with status 400.
 */
async function assertValidResumeFile(file) {
    if (!file?.path) {
        const err = new Error("No file uploaded");
        err.status = 400;
        throw err;
    }

    const ext = path.extname(file.filename || file.originalname || "").toLowerCase();
    const handle = await fs.open(file.path, "r");
    try {
        const buf = Buffer.alloc(8);
        const { bytesRead } = await handle.read(buf, 0, 8, 0);
        if (bytesRead < 4) {
            const err = new Error("Uploaded file is empty or unreadable");
            err.status = 400;
            throw err;
        }

        if (ext === ".pdf") {
            const header = buf.toString("utf8", 0, 4);
            if (header !== "%PDF") {
                const err = new Error("Invalid PDF file content");
                err.status = 400;
                throw err;
            }
            return;
        }

        if (ext === ".docx") {
            // DOCX is a ZIP archive; local file header signature is PK\x03\x04 (or PK\x05\x06 / PK\x07\x08)
            if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
                const err = new Error("Invalid DOCX file content");
                err.status = 400;
                throw err;
            }
            return;
        }

        const err = new Error("Only PDF and DOCX allowed");
        err.status = 400;
        throw err;
    } finally {
        await handle.close();
    }
}

module.exports = { assertValidResumeFile };
