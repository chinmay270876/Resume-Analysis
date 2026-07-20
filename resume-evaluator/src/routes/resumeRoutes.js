const express = require("express");
const router = express.Router();

const upload = require("../config/multerConfig");

const {
    uploadResume,
    uploadMultipleResumes,
    downloadTranscript,
    downloadReport,
    downloadBatchReport,
    getUploadProgress
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

module.exports = router;
