const {
    appendOrUpdateCandidate,
    MASTER_FILENAME,
    MASTER_FILEPATH,
    HEADERS,
} = require("./excelService");

const REPORT_DIR = process.env.REPORT_DIR || "results";
const BATCH_FILENAME = MASTER_FILENAME;

const CENTER_HEADERS = new Set([
    "Name",
    "Age",
    "Highest Education",
    "Years Of Experience",
    "Notice Period",
    "Last Company",
    "Location",
    "Number of Companies Worked With",
    "Certification",
]);

const activeBatches = new Map();

function getBatch(token) {
    let batch = activeBatches.get(token);
    if (!batch) {
        batch = { addedRows: new Set() };
        activeBatches.set(token, batch);
    }
    return batch;
}

async function appendCandidate(token, rowKey, analysis, evaluation, failed = false) {
    const batch = getBatch(token);

    if (rowKey && batch.addedRows.has(rowKey)) {
        return;
    }

    try {
        await appendOrUpdateCandidate(analysis, evaluation);
    } catch (err) {
        console.error("❌ Master workbook append failed:", err.message);
    }

    if (rowKey) {
        batch.addedRows.add(rowKey);
    }
}

async function finalizeBatch(token) {
    activeBatches.delete(token);

    console.log("Batch finalized:", BATCH_FILENAME);

    return BATCH_FILENAME;
}

function getBatchFilePath() {
    return MASTER_FILEPATH;
}

module.exports = {
    BATCH_FILENAME,
    appendCandidate,
    finalizeBatch,
    getBatchFilePath,
    HEADERS,
};
