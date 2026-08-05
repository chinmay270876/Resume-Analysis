const express = require("express");
const router = express.Router();

const {
    createInterview,
    listInterviews,
    getInterview,
    updateInterview,
    deleteInterview,
    processRemindersNow,
    getInterviewStats,
    getCandidateRanking,
    compareCandidates,
    downloadResultReport,
    downloadExcelSummary,
} = require("../controllers/interviewController");

const {
    completeInterview,
    getTranscript,
    downloadTranscript,
    downloadRecording,
    getEvaluation,
    downloadEvaluation,
    reEvaluate,
} = require("../controllers/podcastTranscriptController");

router.post("/", createInterview);
router.get("/", listInterviews);

// Must be registered before /:id so path segments are not treated as ids
router.post("/reminders/process", processRemindersNow);
router.get("/stats", getInterviewStats);
router.get("/ranking", getCandidateRanking);
router.get("/compare", compareCandidates);

// Podcast Transcript Module — provider-agnostic completion + artifacts
router.post("/:id/complete", completeInterview);
router.get("/:id/transcript", getTranscript);
router.get("/:id/transcript/download", downloadTranscript);
router.get("/:id/recording", downloadRecording);
router.get("/:id/evaluation", getEvaluation);
router.get("/:id/evaluation/download", downloadEvaluation);
router.post("/:id/evaluate", reEvaluate);

// Final Result Module — report download (after evaluation + result)
router.get("/:id/result/download", downloadResultReport);
router.get("/:id/excel/download", downloadExcelSummary);

router.get("/:id", getInterview);
router.patch("/:id", updateInterview);
router.delete("/:id", deleteInterview);

module.exports = router;
