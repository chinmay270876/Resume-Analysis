const ExcelJS = require("exceljs");
const path = require("path");
const fsp = require("fs").promises;

const REPORT_DIR = process.env.REPORT_DIR || "results";
const MASTER_FILENAME = "Resume Evaluation.xlsx";
const MASTER_FILEPATH = path.join(process.cwd(), REPORT_DIR, MASTER_FILENAME);

const HEADERS = [
    "Name",
    "Age",
    "Highest Education",
    "Years Of Experience",
    "Notice Period",
    "Last Company",
    "Location",
    "Major Skills",
    "Additional (If Any)",
    "Number of Companies Worked With",
    "Certification",
    "ATS Score",
    "ATS Grade",
    "ATS Summary",
    "Missing Keywords",
    "Format Issues",
    "Recommendations",
];

const WRAP_HEADERS = new Set([
    "Major Skills",
    "Additional (If Any)",
    "Certification",
    "ATS Summary",
    "Missing Keywords",
    "Format Issues",
    "Recommendations",
]);

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

async function getMasterWorkbook() {
    const reportDir = path.join(process.cwd(), REPORT_DIR);
    await fsp.mkdir(reportDir, { recursive: true });

    const workbook = new ExcelJS.Workbook();
    const exists = await fsp.access(MASTER_FILEPATH).then(() => true).catch(() => false);

    console.log("Opening Resume Evaluation.xlsx...");
    console.log("Workbook exists:", exists);

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

    worksheet.columns = HEADERS.map((header) => ({ header, key: header, width: 30 }));
    worksheet.getRow(1).font = { bold: true };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    return workbook;
}

function findDuplicateRow(worksheet, name, lastCompany) {
    if (!name) return null;
    const key = name.toLowerCase().trim();
    let matchRow = null;

    worksheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const rowName = String(row.getCell(1).value || "").toLowerCase().trim();
        if (rowName !== key) return;

        const rowLastCompany = String(row.getCell(6).value || "").toLowerCase().trim();

        if (lastCompany && rowLastCompany && rowLastCompany === lastCompany.toLowerCase().trim()) {
            matchRow = rowNum;
        }
    });

    return matchRow;
}

let excelMutex = Promise.resolve();

async function appendOrUpdateCandidate(analysis, evaluation, atsEvaluation) {
    const nextTask = excelMutex.then(() => _appendOrUpdateCandidateImpl(analysis, evaluation, atsEvaluation));
    excelMutex = nextTask.catch(() => {});
    return nextTask;
}

async function _appendOrUpdateCandidateImpl(analysis, evaluation, atsEvaluation) {
    const candidateName =
        (typeof analysis.candidateName === "string" && analysis.candidateName.trim()) ||
        (typeof analysis.name === "string" && analysis.name.trim()) ||
        "Unknown Candidate";

    console.log("Appending candidate:");
    console.log(candidateName);

    const workbook = await getMasterWorkbook();
    const worksheet = workbook.getWorksheet("Candidates");

    const name = candidateName;
    const email = safeName(analysis.email);
    const lastCompany = safeName(
        analysis.currentCompany ||
        analysis.company ||
        analysis.currentEmployer ||
        analysis.employer ||
        analysis.organization
    );

    let existingRow = findDuplicateRow(worksheet, name, lastCompany);
    console.log("Duplicate found:", existingRow !== null);

    const MAX_ROW = 1048576;
    if (existingRow && (existingRow < 1 || existingRow > MAX_ROW)) {
        console.warn("Duplicate row index out of valid bounds, treating as new row.");
        existingRow = null;
    }

    const age = safeName(analysis.age);
    const highestEducation = safeName(
        analysis.highestEducation ||
        analysis.education ||
        analysis.qualification
    );
    const yearsOfExperience = safeName(
        analysis.yearsOfExperience ||
        analysis.yoe ||
        analysis.totalExperience ||
        analysis.experienceYears
    );
    const noticePeriod = safeName(analysis.noticePeriod);
    const location = safeName(analysis.location);
    const majorSkills = joinSafe(analysis.skills);
    const additional = safeName(analysis.additional);
    const numCompanies = safeName(analysis.numberOfCompaniesWorkedWith);
    const certification = joinSafe(analysis.certifications);

    const atsScore = atsEvaluation?.atsScore != null ? atsEvaluation.atsScore : "";
    const atsGrade = safeName(atsEvaluation?.atsGrade);
    const atsSummary = safeName(atsEvaluation?.atsSummary);
    const missingKeywords = joinSafe(atsEvaluation?.missingKeywords);
    const formatIssues = joinSafe(atsEvaluation?.formatIssues);
    const recommendations = joinSafe(atsEvaluation?.recommendations);

    const rowData = {
        "Name": name,
        "Age": age,
        "Highest Education": highestEducation,
        "Years Of Experience": yearsOfExperience,
        "Notice Period": noticePeriod,
        "Last Company": lastCompany,
        "Location": location,
        "Major Skills": majorSkills,
        "Additional (If Any)": additional,
        "Number of Companies Worked With": numCompanies,
        "Certification": certification,
        "ATS Score": atsScore,
        "ATS Grade": atsGrade,
        "ATS Summary": atsSummary,
        "Missing Keywords": missingKeywords,
        "Format Issues": formatIssues,
        "Recommendations": recommendations,
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

module.exports = {
    generateExcelReport,
    appendOrUpdateCandidate,
    MASTER_FILENAME,
    MASTER_FILEPATH,
};
