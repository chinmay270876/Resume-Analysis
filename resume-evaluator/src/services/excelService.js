const ExcelJS = require("exceljs");
const path = require("path");
const fsp = require("fs").promises;
const { setLastReport } = require("../utils/lastReportStore");

const WRAP_HEADERS = ["Experience", "Skills", "Strengths", "Weaknesses", "Evaluation"];
const CENTER_HEADERS = ["Candidate Name", "Candidate Mobile No.", "Candidate Email ID", "Current Company", "Years of Experience (YOE)"];

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

async function generateExcelReport(analysis, evaluation, uniqueSuffix = "") {
    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Candidate Evaluation");

        worksheet.mergeCells("A1:J1");
        worksheet.getCell("A1").value = "Resume Evaluation Report";
        worksheet.getCell("A1").font = { size: 16, bold: true };
        worksheet.addRow([]);

        worksheet.columns = [
            { header: "Candidate Name", key: "candidateName", width: 30 },
            { header: "Candidate Mobile No.", key: "phone", width: 20 },
            { header: "Candidate Email ID", key: "email", width: 30 },
            { header: "Current Company", key: "currentCompany", width: 30 },
            { header: "Years of Experience (YOE)", key: "yearsOfExperience", width: 20 },
            { header: "Experience", key: "experience", width: 20 },
            { header: "Skills", key: "skills", width: 50 },
            { header: "Strengths", key: "strengths", width: 50 },
            { header: "Weaknesses", key: "weaknesses", width: 50 },
            { header: "Evaluation", key: "evaluation", width: 50 },
        ];

        const candidateName =
            (typeof analysis.candidateName === "string" && analysis.candidateName.trim()) ||
            (typeof analysis.name === "string" && analysis.name.trim()) ||
            "Unknown Candidate";

        const safeName = (value) =>
            (typeof value === "string" && value.trim()) || "";

        const joinSafe = (arr) =>
            Array.isArray(arr) ? arr.filter((x) => x != null).map(String).join(", ") : "";

        const currentCompany = safeName(
            analysis.currentCompany ||
            analysis.company ||
            analysis.currentEmployer ||
            analysis.employer ||
            analysis.organization
        );

        const yearsOfExperience = safeName(
            analysis.yearsOfExperience ||
            analysis.yoe ||
            analysis.totalExperience ||
            analysis.experienceYears
        );

        let evaluationText = "";
        if (evaluation && typeof evaluation === "object") {
            const parts = [];
            const result = safeName(evaluation.result);
            const recommendation = safeName(evaluation.recommendation);
            const score =
                typeof evaluation.overallScore === "number" ? evaluation.overallScore :
                typeof evaluation.score === "number" ? evaluation.score :
                null;
            if (result) parts.push(result);
            if (recommendation) parts.push(recommendation);
            if (score !== null) parts.push(`Score: ${score}`);
            evaluationText = parts.join(" / ");
        }

        worksheet.addRow({
            candidateName,
            phone: safeName(analysis.phone),
            email: safeName(analysis.email),
            currentCompany,
            yearsOfExperience,
            experience: safeName(analysis.experience),
            skills: joinSafe(analysis.skills),
            strengths: joinSafe(analysis.strengths),
            weaknesses: joinSafe(analysis.weaknesses),
            evaluation: evaluationText,
        });

        const headerRow = worksheet.getRow(3);
        headerRow.font = { bold: true };

        worksheet.columns.forEach((col) => {
            if (!col) return;
            if (CENTER_HEADERS.includes(col.header)) {
                col.alignment = { horizontal: "center", vertical: "middle" };
            } else if (WRAP_HEADERS.includes(col.header)) {
                col.alignment = { vertical: "top", wrapText: true };
            }
        });

        worksheet.views = [{ state: "frozen", ySplit: 1 }];

        autoSizeColumns(worksheet);

        const reportDir = path.join(process.cwd(), process.env.REPORT_DIR || "results");
        await fsp.mkdir(reportDir, { recursive: true });

        const safeFileName = candidateName.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, "_");
        const suffix = uniqueSuffix ? `_${uniqueSuffix}` : "";
        const fileName = `${safeFileName}${suffix}_Evaluation.xlsx`;
        const filePath = path.join(reportDir, fileName);

        await workbook.xlsx.writeFile(filePath);

        setLastReport(fileName);

        console.log("Report generated:", fileName);
        console.log("Absolute path:", filePath);
        const fileExists = await fsp.access(filePath).then(() => true).catch(() => false);
        console.log("File exists:", fileExists);
        console.log("Workbook saved:", filePath);
        const stats = await fsp.stat(filePath);
        console.log("Workbook size:", stats.size);
        console.log("Download filename:", fileName);

        return fileName;
    } catch (error) {
        console.error("Failed to generate Excel report:", error);
        throw error;
    }
}

module.exports = {
    generateExcelReport,
};
