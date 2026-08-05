const express = require("express");
const router = express.Router();

const upload = require("../config/multerConfig");

const {
    uploadResume,
    uploadMultipleResumes,
    downloadTranscript,
    downloadReport,
    downloadBatchReport,
    getUploadProgress,
    parseJobDescription,
    rankCandidates,
    generateInterviewQuestions,
    resetReport
} = require("../controllers/resumeController");

// =====================================
// Upload Single Resume
// =====================================

router.post(
    "/upload-resume",
    upload.single("resume"),
    uploadResume
);

// =====================================
// Upload Multiple Resumes (Batch)
// =====================================

router.post(
    "/upload-resumes",
    upload.array("resumes", 5),
    uploadMultipleResumes
);

// =====================================
// Parse Job Description
// =====================================

router.post(
    "/parse-jd",
    upload.single("jobDescription"),
    parseJobDescription
);

// =====================================
// Rank Candidates Against JD
// =====================================

router.post(
    "/rank-candidates",
    rankCandidates
);

// =====================================
// Generate Structured Interview (JD-primary + resume personalization)
// =====================================

router.post(
    "/generate-interview",
    upload.fields([
        { name: "resume", maxCount: 1 },
        { name: "jobDescription", maxCount: 1 },
    ]),
    generateInterviewQuestions
);

// =====================================
// Get Upload Progress
// =====================================

router.get(
    "/upload-progress/:uploadId",
    getUploadProgress
);

// =====================================
// Download Transcript
// =====================================

router.get(
    "/download-transcript/:filename",
    downloadTranscript
);

router.get(
    "/download-transcript",
    downloadTranscript
);

// =====================================
// Download Excel Evaluation Report
// =====================================

router.get(
    "/download-report/:filename",
    downloadReport
);

router.get(
    "/download-report",
    downloadReport
);

// =====================================
// Download Batch Excel Evaluation Report
// =====================================

router.get(
    "/download-batch-report",
    downloadBatchReport
);

// =====================================
// Reset Excel Report (start a fresh session)
// =====================================

router.post(
    "/reset-report",
    resetReport
);

module.exports = router;
