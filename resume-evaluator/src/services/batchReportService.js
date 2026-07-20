const ExcelJS = require("exceljs");
const path = require("path");
const fsp = require("fs").promises;

const REPORT_DIR = process.env.REPORT_DIR || "results";
const BATCH_FILENAME = "Candidate_Evaluation_Report.xlsx";

const HEADERS = [
    "Candidate Name",
    "Candidate Mobile No.",
    "Candidate Email ID",
    "Current Company",
    "Years of Experience (YOE)",
    "Experience",
    "Skills",
    "Strengths",
    "Weaknesses",
    "Evaluation",
];

const WRAP_HEADERS = new Set(["Experience", "Skills", "Strengths", "Weaknesses", "Evaluation"]);
const CENTER_HEADERS = new Set(["Candidate Name", "Candidate Mobile No.", "Candidate Email ID", "Current Company", "Years of Experience (YOE)"]);

const activeBatches = new Map();

function joinSafe(value) {
    if (Array.isArray(value)) {
        return value.filter((x) => x != null).map(String).join(", ");
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function safeName(value) {
    return (typeof value === "string" && value.trim()) || "";
}

function buildEvaluationCell(evaluation, failed) {
    if (failed) {
        return "FAILED";
    }
    if (!evaluation || typeof evaluation !== "object") {
        return "";
    }

    const result = safeName(evaluation.result);
    const recommendation = safeName(evaluation.recommendation);
    const score =
        typeof evaluation.overallScore === "number" ? evaluation.overallScore :
        typeof evaluation.score === "number" ? evaluation.score :
        null;

    const parts = [];
    if (result) parts.push(result);
    if (recommendation) parts.push(recommendation);
    if (score !== null) parts.push(`Score: ${score}`);

    return parts.join(" / ");
}

function buildRowData(analysis, evaluation, failed) {
    const a = analysis || {};
    const currentCompany = safeName(
        a.currentCompany ||
        a.company ||
        a.currentEmployer ||
        a.employer ||
        a.organization
    );
    const yearsOfExperience = safeName(
        a.yearsOfExperience ||
        a.yoe ||
        a.totalExperience ||
        a.experienceYears
    );
    return {
        "Candidate Name": safeName(a.candidateName || a.name),
        "Candidate Mobile No.": safeName(a.phone),
        "Candidate Email ID": safeName(a.email),
        "Current Company": currentCompany,
        "Years of Experience (YOE)": yearsOfExperience,
        "Experience": safeName(a.experience),
        "Skills": joinSafe(a.skills),
        "Strengths": joinSafe(a.strengths),
        "Weaknesses": joinSafe(a.weaknesses),
        "Evaluation": buildEvaluationCell(evaluation, failed),
    };
}

function autoSizeColumns(worksheet) {
    worksheet.columns.forEach((col, index) => {
        let maxLen = 0;
        const colIndex = index + 1;
        worksheet.eachRow((row) => {
            const cell = row.getCell(colIndex);
            const val = cell.value != null ? String(cell.value) : "";
            if (val.length > maxLen) maxLen = val.length;
        });
        col.width = Math.min(Math.max(maxLen + 2, 10), 60);
    });
}

function createWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Candidates");

    worksheet.columns = HEADERS.map((header) => ({ header, key: header, width: 30 }));

    worksheet.getRow(1).font = { bold: true };

    HEADERS.forEach((header, index) => {
        const cell = worksheet.getCell(index + 1, 1);
        if (CENTER_HEADERS.has(header)) {
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        } else if (WRAP_HEADERS.has(header)) {
            cell.alignment = { vertical: "middle", wrapText: true };
        } else {
            cell.alignment = { vertical: "middle", wrapText: true };
        }
    });

    worksheet.views = [{ state: "frozen", ySplit: 1 }];
    worksheet.autoFilter = { from: "A1", to: "J1" };

    return { workbook, worksheet, addedRows: new Set() };
}

function getBatch(token) {
    let batch = activeBatches.get(token);
    if (!batch) {
        batch = createWorkbook();
        activeBatches.set(token, batch);
    }
    return batch;
}

function appendCandidate(token, rowKey, analysis, evaluation, failed = false) {
    const batch = getBatch(token);

    if (rowKey && batch.addedRows.has(rowKey)) {
        return;
    }

    const rowData = buildRowData(analysis, evaluation, failed);
    batch.worksheet.addRow(rowData);

    const addedRow = batch.worksheet.lastRow;
    HEADERS.forEach((header, index) => {
        const cell = addedRow.getCell(index + 1);
        if (WRAP_HEADERS.has(header)) {
            cell.alignment = { vertical: "top", wrapText: true };
        } else if (CENTER_HEADERS.has(header)) {
            cell.alignment = { horizontal: "center", vertical: "middle" };
        }
    });

    if (rowKey) {
        batch.addedRows.add(rowKey);
    }
}

async function finalizeBatch(token) {
    const batch = activeBatches.get(token);
    if (!batch) {
        return null;
    }

    const reportDir = path.join(process.cwd(), REPORT_DIR);
    await fsp.mkdir(reportDir, { recursive: true });
    const filePath = path.join(reportDir, BATCH_FILENAME);

    autoSizeColumns(batch.worksheet);

    await batch.workbook.xlsx.writeFile(filePath);

    activeBatches.delete(token);

    console.log("Report generated:", BATCH_FILENAME);
    console.log("Absolute path:", filePath);
    const fileExists = await fsp.access(filePath).then(() => true).catch(() => false);
    console.log("File exists:", fileExists);
    console.log("Workbook saved:", filePath);
    const stats = await fsp.stat(filePath);
    console.log("Workbook size:", stats.size);
    console.log("Download filename:", BATCH_FILENAME);

    return BATCH_FILENAME;
}

function getBatchFilePath() {
    return path.join(process.cwd(), REPORT_DIR, BATCH_FILENAME);
}

module.exports = {
    BATCH_FILENAME,
    appendCandidate,
    finalizeBatch,
    getBatchFilePath,
    HEADERS,
};
