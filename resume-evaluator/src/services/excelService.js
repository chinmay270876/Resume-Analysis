const ExcelJS = require("exceljs");
const path = require("path");
const fsp = require("fs").promises;

const REPORT_DIR = process.env.REPORT_DIR || "results";
const MASTER_FILENAME = "Resume Evaluation.xlsx";
const MASTER_FILEPATH = path.join(process.cwd(), REPORT_DIR, MASTER_FILENAME);

const HEADERS = [
    "Name",
    "Ranking",
    "Age",
    "Contact Number",
    "Email Id",
    "Highest Education",
    "Years of Experience",
    "Notice Period",
    "Last Company",
    "Location",
    "Major Skills",
    "Skills missed from JD",
    "Number of companies worked with",
    "Certification",
    "Reason for Rank",
];

const RANKING_HEADERS = [
    "Rank",
    "Candidate Name",
    "Match Score",
    "Strengths / Weaknesses Summary",
    "Recommendation",
];

const WRAP_HEADERS = new Set([
    "Major Skills",
    "Skills missed from JD",
    "Certification",
    "Reason for Rank",
    "Strengths / Weaknesses Summary",
]);

const MISSING_VALUE = "-";
const PLACEHOLDER_RE = /^(not\s*available|not\s*found|not\s*provided|n\/?a|na|null|none|unknown|undefined|missing|-+)$/i;

function autoSizeColumns(worksheet) {
    const MAX_COL = 16384;
    worksheet.columns.forEach((col, index) => {
        const colIndex = index + 1;
        if (colIndex > MAX_COL) return;
        let maxLen = 0;
        worksheet.eachRow((row) => {
            const cell = row.getCell(colIndex);
            const val = cell.value != null ? String(cell.value) : "";
            if (val.length > maxLen) maxLen = val.length;
        });
        col.width = Math.min(Math.max(maxLen + 2, 10), 60);
    });
}

function safeName(value) {
    return (typeof value === "string" && value.trim()) || "";
}

function joinSafe(value) {
    if (Array.isArray(value)) {
        return value.filter((x) => x != null).map(String).join(", ");
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

function isPlaceholder(value) {
    if (typeof value !== "string") {
        return false;
    }
    const trimmed = value.trim();
    return !trimmed || PLACEHOLDER_RE.test(trimmed);
}

function toExcelValue(value) {
    if (Array.isArray(value)) {
        const joined = joinSafe(value).trim();
        return joined && !isPlaceholder(joined) ? joined : MISSING_VALUE;
    }
    if (value === null || value === undefined) {
        return MISSING_VALUE;
    }
    if (typeof value === "number" && !Number.isNaN(value)) {
        return String(value);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed && !isPlaceholder(trimmed) ? trimmed : MISSING_VALUE;
    }
    const asString = String(value).trim();
    return asString && !isPlaceholder(asString) ? asString : MISSING_VALUE;
}

async function getMasterWorkbook() {
    const reportDir = path.join(process.cwd(), REPORT_DIR);
    await fsp.mkdir(reportDir, { recursive: true });

    const workbook = new ExcelJS.Workbook();
    const exists = await fsp.access(MASTER_FILEPATH).then(() => true).catch(() => false);

    if (process.env.NODE_ENV !== "production") {
        console.log("Opening Resume Evaluation.xlsx... exists:", exists);
    }

    let worksheet;
    if (exists) {
        await workbook.xlsx.readFile(MASTER_FILEPATH);
        worksheet = workbook.getWorksheet("Candidates");
        if (!worksheet) {
            worksheet = workbook.addWorksheet("Candidates");
        }
    } else {
        worksheet = workbook.addWorksheet("Candidates");
    }

    ensureCandidatesWorksheetLayout(worksheet);
    ensureRankingWorksheet(workbook);

    return workbook;
}

function ensureRankingWorksheet(workbook) {
    let rankingSheet = workbook.getWorksheet("Ranking");
    if (!rankingSheet) {
        rankingSheet = workbook.addWorksheet("Ranking");
    }
    rankingSheet.columns = RANKING_HEADERS.map((header) => ({ header, key: header, width: 30 }));
    rankingSheet.getRow(1).font = { bold: true };
    rankingSheet.views = [{ state: "frozen", ySplit: 1 }];
    return rankingSheet;
}

function readHeaderRow(worksheet) {
    const headerRow = worksheet.getRow(1);
    const headers = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
        headers[colNumber - 1] = String(cell.value || "").trim();
    });
    return headers;
}

function headersMatch(currentHeaders) {
    if (currentHeaders.length !== HEADERS.length) return false;
    return HEADERS.every((header, index) => currentHeaders[index] === header);
}

/** Rebuild Candidates sheet so columns match HEADERS (e.g. Ranking after Name). */
function ensureCandidatesWorksheetLayout(worksheet) {
    const currentHeaders = readHeaderRow(worksheet);
    const hasDataRows = worksheet.rowCount > 1;

    if (!hasDataRows || !currentHeaders.some(Boolean) || headersMatch(currentHeaders)) {
        worksheet.columns = HEADERS.map((header) => ({ header, key: header, width: 30 }));
        worksheet.getRow(1).font = { bold: true };
        worksheet.views = [{ state: "frozen", ySplit: 1 }];
        return;
    }

    const rows = [];
    worksheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const rowData = {};
        HEADERS.forEach((header) => {
            const oldIndex = currentHeaders.indexOf(header);
            rowData[header] = oldIndex >= 0 ? (row.getCell(oldIndex + 1).value ?? MISSING_VALUE) : MISSING_VALUE;
        });
        rows.push(rowData);
    });

    while (worksheet.rowCount > 1) {
        worksheet.spliceRows(2, 1);
    }

    worksheet.columns = HEADERS.map((header) => ({ header, key: header, width: 30 }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    for (const rowData of rows) {
        worksheet.addRow(rowData);
    }
}

function parseRankValue(value) {
    if (value == null || value === MISSING_VALUE) return Number.POSITIVE_INFINITY;
    const num = Number(String(value).trim());
    return Number.isFinite(num) && num > 0 ? num : Number.POSITIVE_INFINITY;
}

/** Sort Candidates data rows by Ranking ascending (unranked last). */
function sortCandidatesByRanking(worksheet) {
    const rankingCol = HEADERS.indexOf("Ranking") + 1;
    if (rankingCol < 1 || worksheet.rowCount <= 2) return;

    const rows = [];
    worksheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const values = HEADERS.map((_, index) => row.getCell(index + 1).value);
        rows.push({
            rank: parseRankValue(row.getCell(rankingCol).value),
            originalIndex: rowNum,
            values,
        });
    });

    rows.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.originalIndex - b.originalIndex;
    });

    while (worksheet.rowCount > 1) {
        worksheet.spliceRows(2, 1);
    }

    for (const entry of rows) {
        const rowData = {};
        HEADERS.forEach((header, index) => {
            rowData[header] = entry.values[index] ?? MISSING_VALUE;
        });
        worksheet.addRow(rowData);
    }
}

function formatStrengthsWeaknessesSummary(entry) {
    const bullets = entry.rank <= 2
        ? (Array.isArray(entry.strengths) ? entry.strengths : [])
        : (Array.isArray(entry.weaknesses) ? entry.weaknesses : []);
    if (!bullets.length) {
        return MISSING_VALUE;
    }
    return bullets.map((item) => `• ${item}`).join("\n");
}

function findDuplicateRow(worksheet, name, lastCompany) {
    if (!name || name === MISSING_VALUE) return null;
    const nameCol = HEADERS.indexOf("Name") + 1;
    const lastCompanyCol = HEADERS.indexOf("Last Company") + 1;
    const key = name.toLowerCase().trim();
    let matchRow = null;

    worksheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const rowName = String(row.getCell(nameCol).value || "").toLowerCase().trim();
        if (rowName !== key || rowName === MISSING_VALUE) return;

        const rowLastCompany = String(row.getCell(lastCompanyCol).value || "").toLowerCase().trim();

        if (lastCompany && rowLastCompany && rowLastCompany !== MISSING_VALUE &&
            rowLastCompany === lastCompany.toLowerCase().trim()) {
            matchRow = rowNum;
        }
    });

    return matchRow;
}

function findRowsByCandidateName(worksheet, name) {
    if (!name || name === MISSING_VALUE) return [];
    const nameCol = HEADERS.indexOf("Name") + 1;
    const key = name.toLowerCase().trim();
    const rows = [];

    worksheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const rowName = String(row.getCell(nameCol).value || "").toLowerCase().trim();
        if (rowName === key && rowName !== MISSING_VALUE) {
            rows.push(rowNum);
        }
    });

    return rows;
}

function updateCandidatesSheetRanking(worksheet, rankings) {
    const rankingCol = HEADERS.indexOf("Ranking") + 1;
    const reasonCol = HEADERS.indexOf("Reason for Rank") + 1;

    for (const entry of rankings) {
        const candidateName = safeName(entry.candidateName);
        if (!candidateName) continue;

        const rowNums = findRowsByCandidateName(worksheet, candidateName);
        const rankValue = entry.rank != null ? String(entry.rank) : MISSING_VALUE;
        const reasonValue = toExcelValue(entry.reason);

        for (const rowNum of rowNums) {
            const row = worksheet.getRow(rowNum);
            row.getCell(rankingCol).value = rankValue;
            row.getCell(reasonCol).value = reasonValue;
        }
    }
}

let excelMutex = Promise.resolve();

async function appendOrUpdateCandidate(analysis, evaluation, atsEvaluation, failed = false) {
    const nextTask = excelMutex.then(() =>
        _appendOrUpdateCandidateImpl(analysis, evaluation, atsEvaluation, failed)
    );
    excelMutex = nextTask.catch(() => {});
    return nextTask;
}

async function _appendOrUpdateCandidateImpl(analysis, evaluation, atsEvaluation, failed = false) {
    const candidateName =
        safeName(analysis?.candidateName) ||
        safeName(analysis?.name);

    if (process.env.NODE_ENV !== "production") {
        console.log("Appending candidate:", candidateName || MISSING_VALUE, failed ? "(failed)" : "");
    }

    const workbook = await getMasterWorkbook();
    const worksheet = workbook.getWorksheet("Candidates");

    const lastCompanyRaw = safeName(
        analysis?.currentCompany ||
        analysis?.company ||
        analysis?.currentEmployer ||
        analysis?.employer ||
        analysis?.organization
    );

    let existingRow = findDuplicateRow(worksheet, candidateName, lastCompanyRaw);
    if (process.env.NODE_ENV !== "production") {
        console.log("Duplicate found:", existingRow !== null);
    }

    const MAX_ROW = 1048576;
    if (existingRow && (existingRow < 1 || existingRow > MAX_ROW)) {
        console.warn("Duplicate row index out of valid bounds, treating as new row.");
        existingRow = null;
    }

    const rowData = {
        "Name": toExcelValue(candidateName),
        "Age": toExcelValue(analysis?.age),
        "Contact Number": toExcelValue(analysis?.phone),
        "Email Id": toExcelValue(analysis?.email),
        "Highest Education": toExcelValue(
            analysis?.highestEducation ||
            analysis?.education ||
            analysis?.qualification
        ),
        "Years of Experience": toExcelValue(
            analysis?.yearsOfExperience ||
            analysis?.yoe ||
            analysis?.totalExperience ||
            analysis?.experienceYears
        ),
        "Notice Period": toExcelValue(analysis?.noticePeriod),
        "Last Company": toExcelValue(lastCompanyRaw),
        "Location": toExcelValue(analysis?.location),
        "Major Skills": toExcelValue(analysis?.skills),
        "Skills missed from JD": toExcelValue(atsEvaluation?.missingKeywords),
        "Number of companies worked with": toExcelValue(analysis?.numberOfCompaniesWorkedWith),
        "Certification": toExcelValue(analysis?.certifications),
        "Ranking": failed ? "Failed" : MISSING_VALUE,
        "Reason for Rank": failed ? "Resume processing failed" : MISSING_VALUE,
    };

    if (existingRow) {
        const row = worksheet.getRow(existingRow);
        HEADERS.forEach((header, index) => {
            row.getCell(index + 1).value = rowData[header];
        });
        console.log("Row updated:", existingRow);
    } else {
        worksheet.addRow(rowData);
        console.log("Row appended:", worksheet.rowCount);
    }

    HEADERS.forEach((header) => {
        const col = worksheet.getColumn(header);
        if (col) {
            if (WRAP_HEADERS.has(header)) {
                col.alignment = { vertical: "top", wrapText: true };
            } else {
                col.alignment = { vertical: "middle", wrapText: true };
            }
        }
    });

    autoSizeColumns(worksheet);

    await workbook.xlsx.writeFile(MASTER_FILEPATH);
    console.log("Workbook saved successfully.");
    console.log("Download serving:");
    console.log(MASTER_FILENAME);

    return MASTER_FILENAME;
}

async function generateExcelReport(analysis, evaluation, uniqueSuffix = "", atsEvaluation) {
    return appendOrUpdateCandidate(analysis, evaluation, atsEvaluation);
}

// Recreates the master workbook from its template so that it contains only
// the header row. This is invoked on a fresh frontend session (page refresh)
// to guarantee the next upload starts with a clean report while preserving the
// workbook template: headers, column widths, styles and the frozen header view.
// The report folder itself is intentionally left intact.
async function resetWorkbook() {
    const nextTask = excelMutex.then(() => _resetWorkbookImpl());
    excelMutex = nextTask.catch(() => {});
    return nextTask;
}

async function _resetWorkbookImpl() {
    const reportDir = path.join(process.cwd(), REPORT_DIR);
    await fsp.mkdir(reportDir, { recursive: true });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Candidates");
    worksheet.columns = HEADERS.map((header) => ({ header, key: header, width: 30 }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    ensureRankingWorksheet(workbook);

    await workbook.xlsx.writeFile(MASTER_FILEPATH);
    console.log("Workbook reset to header-only state:", MASTER_FILENAME);
    return MASTER_FILENAME;
}

async function writeCandidateRanking(rankings) {
    const nextTask = excelMutex.then(() => _writeCandidateRankingImpl(rankings));
    excelMutex = nextTask.catch(() => {});
    return nextTask;
}

async function _writeCandidateRankingImpl(rankings) {
    if (!Array.isArray(rankings) || rankings.length === 0) {
        return MASTER_FILENAME;
    }

    const workbook = await getMasterWorkbook();
    const rankingSheet = ensureRankingWorksheet(workbook);
    const candidatesSheet = workbook.getWorksheet("Candidates");

    while (rankingSheet.rowCount > 1) {
        rankingSheet.spliceRows(2, 1);
    }

    const sortedRankings = [...rankings].sort(
        (a, b) => (Number(a.rank) || Number.POSITIVE_INFINITY) - (Number(b.rank) || Number.POSITIVE_INFINITY)
    );

    for (const entry of sortedRankings) {
        rankingSheet.addRow({
            "Rank": toExcelValue(entry.rank),
            "Candidate Name": toExcelValue(entry.candidateName),
            "Match Score": entry.matchScore != null ? `${entry.matchScore}%` : MISSING_VALUE,
            "Strengths / Weaknesses Summary": formatStrengthsWeaknessesSummary(entry),
            "Recommendation": toExcelValue(entry.recommendation),
        });
    }

    if (candidatesSheet) {
        updateCandidatesSheetRanking(candidatesSheet, rankings);
        sortCandidatesByRanking(candidatesSheet);

        HEADERS.forEach((header) => {
            const col = candidatesSheet.getColumn(header);
            if (col) {
                col.alignment = {
                    vertical: "top",
                    wrapText: WRAP_HEADERS.has(header),
                };
            }
        });

        autoSizeColumns(candidatesSheet);
    }

    RANKING_HEADERS.forEach((header) => {
        const col = rankingSheet.getColumn(header);
        if (col) {
            col.alignment = {
                vertical: "top",
                wrapText: WRAP_HEADERS.has(header),
            };
        }
    });

    autoSizeColumns(rankingSheet);

    await workbook.xlsx.writeFile(MASTER_FILEPATH);
    console.log("Ranking worksheet updated:", rankings.length, "candidates");
    return MASTER_FILENAME;
}

module.exports = {
    generateExcelReport,
    appendOrUpdateCandidate,
    resetWorkbook,
    writeCandidateRanking,
    MASTER_FILENAME,
    MASTER_FILEPATH,
    HEADERS,
    RANKING_HEADERS,
};
