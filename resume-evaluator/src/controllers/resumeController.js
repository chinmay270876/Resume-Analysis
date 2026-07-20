const {
    extractJsonFromText
} = require("../utils/jsonUtils");

const {
    generatePodcast
} = require("../services/podcastService");

const {
    generatePodcastScript
} = require("../services/podcastScriptGenerator");

const {
    savePodcastScript
} = require("../services/podcastScriptSaver");

const {
    extractPdfText
} = require("../services/resumeParser");

const {
    analyzeResume
} = require("../services/openaiService");

const {
    generateInterview
} = require("../services/interviewGenerator");

const {
    evaluateCandidate
} = require("../services/evaluationService");

const {
    generateExcelReport
} = require("../services/excelService");

const {
    appendCandidate: appendBatchCandidate,
    finalizeBatch: finalizeBatchReport
} = require("../services/batchReportService");

const {
    saveTranscript
} = require("../services/transcriptService");

const lastReportStore = require("../utils/lastReportStore");

const {
    sendInterviewInvite,
    isValidEmail
} = require("../services/emailService");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs").promises;
const path = require("path");
const progressStore = require("../utils/progressStore");

const VALID_EXTENSIONS = [".pdf", ".docx"];
const MAX_RESUMES = 5;
const MAX_RESUME_CHARS = 15000;

async function safeUnlink(filePath) {
    if (!filePath) return;
    try {
        await fs.unlink(filePath);
    } catch (err) {
        console.error("Cleanup Error:", err);
    }
}

// =================================================
// SHARED RESUME PROCESSING HELPER
// =================================================

// Normalize an extracted AI string field. Replaces placeholder tokens
// ("Not Provided", "N/A", "null", ...) with an empty string.
function cleanString(value) {
    if (typeof value !== "string") {
        return value;
    }
    const PLACEHOLDER_RE = /^(not\s*provided|n\/?a|null|none|unknown|undefined|-+)$/i;
    const trimmed = value.trim();
    return PLACEHOLDER_RE.test(trimmed) ? "" : trimmed;
}

// STEP 10: Validate that the AI analysis produced the minimum required fields.
// Returns a repaired analysis object. Throws only when the name or skills are
// irrecoverable so we never proceed with an "Unknown Candidate".
function validateAnalysis(analysis) {
    if (!analysis || typeof analysis !== "object") {
        throw new Error("Resume analysis returned no usable object.");
    }

    analysis.candidateName = (cleanString(analysis.candidateName) || cleanString(analysis.name) || "").trim();
    analysis.email = (cleanString(analysis.email) || "").trim();
    analysis.phone = (cleanString(analysis.phone) || "").trim();
    analysis.experience = (cleanString(analysis.experience) || "").trim();
    analysis.currentCompany = (cleanString(analysis.currentCompany) || "").trim();
    analysis.currentDesignation = (cleanString(analysis.currentDesignation) || "").trim();
    analysis.yearsOfExperience = (cleanString(analysis.yearsOfExperience) || "").trim();
    analysis.role = (cleanString(analysis.role) || cleanString(analysis.roleTitle) || "").trim();
    analysis.interviewLevel = (cleanString(analysis.interviewLevel) || "").trim();

    if (Array.isArray(analysis.skills)) {
        analysis.skills = analysis.skills.map((s) => cleanString(s)).filter(Boolean);
    } else {
        analysis.skills = [];
    }
    if (Array.isArray(analysis.strengths)) {
        analysis.strengths = analysis.strengths.map((s) => cleanString(s)).filter(Boolean);
    } else {
        analysis.strengths = [];
    }
    if (Array.isArray(analysis.weaknesses)) {
        analysis.weaknesses = analysis.weaknesses.map((s) => cleanString(s)).filter(Boolean);
    } else {
        analysis.weaknesses = [];
    }

    if (!analysis.candidateName) {
        console.warn("⚠️ VALIDATION WARNING: candidateName missing from AI analysis. Proceeding with caution.");
    }
    if (analysis.skills.length === 0) {
        console.warn("⚠️ VALIDATION WARNING: skills missing/empty from AI analysis.");
    }
    if (!analysis.experience) {
        console.warn("⚠️ VALIDATION WARNING: experience missing from AI analysis.");
    }

    return analysis;
}

async function processResumeFile(file, resumeId, uploadId, onStatusUpdate, batchToken) {
    const startTime = Date.now();
    const createdFiles = [];

    // Track stage timings for pipeline logging.
    const stageTimings = {};

    const timeStage = async (label, fn) => {
        const t0 = Date.now();
        try {
            return await fn();
        } finally {
            stageTimings[label] = Math.round((Date.now() - t0) / 10) / 100;
        }
    };

    const update = (status, extra = {}) => {
        if (typeof onStatusUpdate === "function") {
            onStatusUpdate(resumeId, status, extra);
        }
    };

    const trackFile = (filePath) => {
        if (filePath) {
            createdFiles.push(filePath);
        }
    };

    let analysis;
    let candidateName;
    let interviewTranscript;
    let transcriptFilename;
    let evaluation;

    try {
        // =================================================
        // STEP 1/7: PDF Extraction
        // =================================================

        const resumeTextRaw = await timeStage("pdfExtraction", () =>
            extractPdfText(file.path)
        );

        if (!resumeTextRaw || resumeTextRaw.trim().length === 0) {
            const err = new Error("Could not extract any text from the uploaded resume. The file may be empty, scanned/image-based, or corrupted.");
            err.status = 400;
            throw err;
        }

        const resumeText = resumeTextRaw.length > MAX_RESUME_CHARS
            ? resumeTextRaw.substring(0, MAX_RESUME_CHARS)
            : resumeTextRaw;

        // =================================================
        // STEP 2/7: Resume Analysis
        // =================================================

        update("Analyzing Resume");

        const analysisText = await timeStage("resumeAnalysis", () =>
            analyzeResume(resumeText)
        );

        let rawAnalysis;
        try {
            const jsonString = extractJsonFromText(analysisText);
            if (!jsonString) {
                throw new Error("No valid JSON found in AI response for resume analysis.");
            }
            rawAnalysis = JSON.parse(jsonString);
        } catch (parseError) {
            console.error("========== ANALYSIS ERROR ==========");
            console.error("Failure caused by: JSON.parse()");
            console.error("Reason: ", parseError.message);
            console.error(analysisText);
            console.error("====================================");

            const err = new Error("Invalid resume analysis response from AI.");
            err.status = 500;
            throw err;
        }

        // Validate + repair the AI response before any downstream step.
        analysis = validateAnalysis(rawAnalysis);

        candidateName = analysis.candidateName || "Unknown_Candidate";

        // =================================================
        // STEP 3/7: Interview Generation
        // =================================================

        update("Generating Interview");

        interviewTranscript = await timeStage("interviewGeneration", () =>
            generateInterview(analysis)
        );

        // =================================================
        // STEP 4/7: Save Transcript + Candidate Evaluation
        // =================================================

        update("Saving Transcript");

        transcriptFilename = await timeStage("saveTranscript", () =>
            saveTranscript(interviewTranscript, candidateName, resumeId)
        );
        trackFile(path.join(process.cwd(), process.env.REPORT_DIR || "results", transcriptFilename));

        update("Evaluating Candidate");

        const evaluationText = await timeStage("evaluation", () =>
            evaluateCandidate(interviewTranscript)
        );

        try {
            const jsonString = extractJsonFromText(evaluationText);
            if (!jsonString) {
                throw new Error("No valid JSON found in AI response for evaluation.");
            }
            evaluation = JSON.parse(jsonString);
        } catch (parseError) {
            const err = new Error("Invalid evaluation response from AI.");
            err.status = 500;
            throw err;
        }

        // As soon as AI evaluation finishes, append the candidate into the
        // shared batch report (independent of podcast generation / email).
        if (batchToken) {
            try {
                appendBatchCandidate(batchToken, resumeId, analysis, evaluation, false);
            } catch (batchErr) {
                console.error("❌ Batch report append failed:", batchErr.message);
            }
        }

        // =================================================
        // STEP 5/7: Returning Response (immediately)
        // =================================================

        const endTime = Date.now();
        const elapsedSeconds = Math.round((endTime - startTime) / 1000);

        console.log(`\n=== PIPELINE TIMINGS (${file.originalname}) ===`);
        console.log(`PDF Extraction: ${stageTimings.pdfExtraction}s`);
        console.log(`Resume Analysis: ${stageTimings.resumeAnalysis}s`);
        console.log(`Interview Generation: ${stageTimings.interviewGeneration}s`);
        console.log(`Save Transcript: ${stageTimings.saveTranscript}s`);
        console.log(`Evaluation: ${stageTimings.evaluation}s`);
        console.log(`Total (pre-response): ${elapsedSeconds}s`);
        console.log(`==========================================\n`);

        // Build the response payload. Podcast + reports + email run in the
        // background and are NOT awaited here, so the API returns immediately.
        const responsePayload = {
            success: true,
            filename: file.originalname,
            candidateName: analysis.candidateName || "Unknown",
            email: analysis.email || "",
            evaluation,
            analysis,
            interviewTranscript,
            transcriptFilename,
            podcastScript: null,
            podcastScriptPath: null,
            podcastPath: null,
            reportFilename: null,
            emailSent: false,
            emailSkipped: false,
            emailError: null,
            elapsedSeconds
        };

        // =================================================
        // STEP 5.5/7: Mark resume COMPLETED (synchronous, before return)
        // =================================================
        // The analysis pipeline is done at this point. We mark the resume
        // COMPLETED immediately and BEFORE the background tasks so the UI
        // transitions out of "Waiting.../Queued/Processing" the moment the
        // response is ready. Background podcast/report/email updates are
        // forbidden from clobbering this final state (see updateResumeStatus).

        update("Completed", {
            endTime: Date.now(),
            elapsedSeconds,
            podcastScript: null,
            podcastScriptPath: null,
            podcastPath: null,
            reportFilename: null,
            emailSent: false,
            emailSkipped: false,
            emailError: null
        });

        // =================================================
        // STEP 6/7: Podcast Generation (Background)
        // =================================================

        runBackground("podcast", resumeId, update, async () => {
            const t0 = Date.now();

            update("Generating Podcast Script");
            const podcastScript = await generatePodcastScript(interviewTranscript);
            responsePayload.podcastScript = podcastScript;

            const podcastScriptPath = await savePodcastScript(podcastScript, resumeId);
            trackFile(podcastScriptPath);
            responsePayload.podcastScriptPath = podcastScriptPath;

            update("Generating Podcast");
            const podcastPath = await generatePodcast(interviewTranscript, resumeId);
            trackFile(podcastPath);
            responsePayload.podcastPath = podcastPath;

            const podcastSeconds = Math.round((Date.now() - t0) / 100) / 100;
            console.log(`Podcast (background): ${podcastSeconds}s`);
        }).catch(() => { /* logged inside runBackground */ });

        // =================================================
        // STEP 7/7: Reports + Email (Background)
        // =================================================

        runBackground("reports+email", resumeId, update, async () => {
            const t0 = Date.now();

            const reportFilename = await generateExcelReport(analysis, evaluation, resumeId);
            trackFile(path.join(process.cwd(), process.env.REPORT_DIR || "results", reportFilename));
            responsePayload.reportFilename = reportFilename;

            // Email is non-blocking; failures are logged, never thrown.
            try {
                const recommendation = evaluation.recommendation ? String(evaluation.recommendation).toLowerCase() : "";
                const candidateEmail = analysis.email;

                const positiveRecommendation =
                    recommendation.includes("recommended") ||
                    recommendation.includes("selected") ||
                    recommendation.includes("pass");

                if (candidateEmail && positiveRecommendation && isValidEmail(candidateEmail)) {
                    await sendInterviewInvite(analysis.candidateName, candidateEmail);
                    responsePayload.emailSent = true;
                } else if (!isValidEmail(candidateEmail)) {
                    responsePayload.emailSkipped = true;
                }
            } catch (err) {
                responsePayload.emailError = err.message;
            }

            const reportSeconds = Math.round((Date.now() - t0) / 100) / 100;
            console.log(`Reports + Email (background): ${reportSeconds}s`);
        }).catch(() => { /* logged inside runBackground */ });

        return responsePayload;
    } catch (error) {
        await Promise.all(createdFiles.map(safeUnlink));

        // Even on failure, record the candidate (with whatever partial data
        // we have) as a FAILED row so the batch report stays complete.
        if (batchToken) {
            try {
                appendBatchCandidate(batchToken, resumeId, analysis || { candidateName: file.originalname }, null, true);
            } catch (batchErr) {
                console.error("❌ Batch report failed-row append failed:", batchErr.message);
            }
        }

        throw error;
    }
}

// Fire-and-forget background task. Never rejects into the request path and
// always logs failures without affecting the API response.
function runBackground(label, resumeId, update, task) {
    return Promise.resolve()
        .then(task)
        .catch((err) => {
            console.error(`❌ Background task [${label}] failed for resume ${resumeId}:`, err.message);
            if (typeof update === "function") {
                update("BackgroundError", { label, error: err.message });
            }
        });
}

// =================================================
// UPLOAD SINGLE RESUME
// =================================================

exports.uploadResume = async (
    req,
    res,
    next
) => {

    try {

        if (!req.file) {
            const err = new Error("No file uploaded");
            err.status = 400;
            throw err;
        }

        console.log("-------------------------------------------------");
        console.log("Resume uploaded");
        console.log("-------------------------------------------------");
        console.log("Resume filename:", req.file.filename);
        console.log("Resume size:", req.file.size);

        const singleResumeId = uuidv4();
        const result = await processResumeFile(req.file, singleResumeId, null, null, singleResumeId);

        try {
            await finalizeBatchReport(singleResumeId);
        } catch (batchErr) {
            console.error("❌ Batch report finalize failed:", batchErr.message);
        }

        // ===================================
        // FINAL RESPONSE
        // ===================================

        return res.status(200).json({

            success: true,

            fileName:
                req.file.filename,

            originalName:
                req.file.originalname,

            analysis: result.analysis,

            interviewTranscript: result.interviewTranscript,

            transcriptFilename: result.transcriptFilename,
            transcriptPath: result.transcriptFilename,

            podcastScript: result.podcastScript,

            podcastScriptPath: result.podcastScriptPath,

            podcastPath: result.podcastPath,

            evaluation: result.evaluation,

            reportFilename: result.reportFilename,
            reportPath: result.reportFilename,

            emailSent: result.emailSent,

            emailSkipped: result.emailSkipped,

            emailError: result.emailError,

            elapsedSeconds: result.elapsedSeconds

        });

    } catch (error) {

        next(error);

    } finally {

        if (
            req.file &&
            req.file.path
        ) {

            await safeUnlink(
                req.file.path
            );

        }

    }

};

// =================================================
// UPLOAD MULTIPLE RESUMES
// =================================================

exports.uploadMultipleResumes = async (req, res, next) => {

    try {

        if (!req.files || req.files.length === 0) {
            const err = new Error("No files uploaded");
            err.status = 400;
            throw err;
        }

        if (req.files.length > MAX_RESUMES) {
            const err = new Error(`Maximum ${MAX_RESUMES} resumes allowed. You uploaded ${req.files.length}.`);
            err.status = 400;
            throw err;
        }

        const uploadId = uuidv4();
        const totalResumes = req.files.length;
        const startTime = Date.now();

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        const upload = createUpload(uploadId, totalResumes, startTime);

        console.log(`\n${"=".repeat(60)}`);
        console.log(`BATCH UPLOAD STARTED: ${totalResumes} resumes`);
        console.log(`Upload ID: ${uploadId}`);
        console.log(`${"=".repeat(60)}\n`);

        const results = [];
        let completed = 0;
        let failed = 0;
        let totalProcessingTimeForFinishedResumes = 0;

        const safeWrite = (data) => {
            try {
                if (!res.writableEnded) {
                    res.write(data);
                }
            } catch (writeError) {
                console.error("SSE write error:", writeError.message);
            }
        };

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const resumeId = uuidv4();

            upload.currentResumeIndex = i + 1;

            const resumeRecord = addResume(uploadId, resumeId, file.originalname, file.filename);

            // Initial Queued status
            safeWrite(`data: ${JSON.stringify({
                type: "progress",
                uploadId,
                currentResumeIndex: i + 1,
                totalResumes,
                resumeId,
                filename: file.originalname,
                status: "Queued",
                overallProgress: Math.round(((completed + failed) / totalResumes) * 100),
                currentResumeProgress: progressStore.STATUS_PERCENTAGE["Queued"],
                elapsedTime: Math.round((Date.now() - startTime) / 1000),
                estimatedRemainingTime: null
            })}\n\n`);

            try {
                const result = await processResumeFile(file, resumeId, uploadId, (rid, status, extra) => {
                    updateResumeStatus(uploadId, rid, status, extra);

                    const currentResumeProgress = progressStore.STATUS_PERCENTAGE[status] || 0;
                    const overallElapsedSeconds = Math.round((Date.now() - startTime) / 1000);

                    let estimatedRemainingTime = null;
                    const finishedResumesCount = completed + failed;
                    if (finishedResumesCount > 0) {
                        const averageTimePerFinishedResume = totalProcessingTimeForFinishedResumes / finishedResumesCount;
                        const remainingResumesCount = totalResumes - finishedResumesCount;
                        estimatedRemainingTime = Math.round(averageTimePerFinishedResume * remainingResumesCount);
                    } else if (currentResumeProgress > 0 && (extra.elapsedSeconds || 0) > 0) {
                        const estimatedTotalTimeForCurrentResume = (extra.elapsedSeconds || 0) / (currentResumeProgress / 100);
                        estimatedRemainingTime = Math.round(estimatedTotalTimeForCurrentResume - overallElapsedSeconds);
                    } else if (totalResumes > 0 && overallElapsedSeconds > 0 && upload.currentResumeIndex > 0) {
                        const averageTimeSoFar = overallElapsedSeconds / upload.currentResumeIndex;
                        estimatedRemainingTime = Math.round(averageTimeSoFar * (totalResumes - upload.currentResumeIndex));
                    }

                    safeWrite(`data: ${JSON.stringify({
                        type: "progress",
                        uploadId,
                        currentResumeIndex: i + 1,
                        totalResumes,
                        resumeId,
                        filename: file.originalname,
                        status,
                        overallProgress: Math.round((((completed + failed) + (currentResumeProgress / 100)) / totalResumes) * 100),
                        currentResumeProgress,
                        elapsedTime: overallElapsedSeconds,
                        estimatedRemainingTime,
                        ...extra
                    })}\n\n`);
                }, uploadId);

                results.push(result);
                completed++;
                totalProcessingTimeForFinishedResumes += result.elapsedSeconds;
                console.log(`\n✅ Resume ${i + 1}/${totalResumes} completed: ${file.originalname} (${result.elapsedSeconds}s)\n`);
            } catch (error) {
                const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                const result = {
                    success: false,
                    filename: file.originalname,
                    error: error.message,
                    elapsedSeconds
                };
                results.push(result);
                failed++;
                totalProcessingTimeForFinishedResumes += elapsedSeconds;

                updateResumeStatus(uploadId, resumeId, "Failed", { endTime: Date.now(), elapsedSeconds, error: error.message });

                const overallElapsedSeconds = Math.round((Date.now() - startTime) / 1000);
                let estimatedRemainingTime = null;
                const finishedResumesCount = completed + failed;
                if (finishedResumesCount > 0) {
                    const averageTimePerFinishedResume = totalProcessingTimeForFinishedResumes / finishedResumesCount;
                    const remainingResumesCount = totalResumes - finishedResumesCount;
                    estimatedRemainingTime = Math.round(averageTimePerFinishedResume * remainingResumesCount);
                }

                safeWrite(`data: ${JSON.stringify({
                    type: "progress",
                    uploadId,
                    currentResumeIndex: i + 1,
                    totalResumes,
                    resumeId,
                    filename: file.originalname,
                    status: "Failed",
                    error: error.message,
                    elapsedSeconds,
                    overallProgress: Math.round((finishedResumesCount / totalResumes) * 100),
                    currentResumeProgress: progressStore.STATUS_PERCENTAGE["Failed"],
                    elapsedTime: overallElapsedSeconds,
                    estimatedRemainingTime
                })}\n\n`);
            }

            // Cleanup uploaded file after processing
            if (file.path) {
                await safeUnlink(file.path);
            }
        }

        const overallEndTime = Date.now();
        const overallElapsedSeconds = Math.round((overallEndTime - startTime) / 1000);

        // Once ALL resumes finish processing (regardless of podcast/email),
        // finalize the shared batch workbook once.
        try {
            const batchFile = await finalizeBatchReport(uploadId);
            console.log(`\n📊 Batch report finalized: ${batchFile}`);
        } catch (batchErr) {
            console.error("❌ Batch report finalize failed:", batchErr.message);
        }

        console.log(`\n${"=".repeat(60)}`);
        console.log(`BATCH UPLOAD COMPLETED: ${completed} succeeded, ${failed} failed`);
        console.log(`Total time: ${overallElapsedSeconds}s`);
        console.log(`${"=".repeat(60)}\n`);

        const response = {
            success: failed === 0,
            totalResumes,
            completed,
            failed,
            overallElapsedSeconds,
            results
        };

        safeWrite(`data: ${JSON.stringify({ type: "complete", ...response })}\n\n`);
        res.end();

        cleanupUpload(uploadId);

    } catch (error) {

        if (!res.writableEnded) {
            safeWrite(`data: ${JSON.stringify({ type: "error", error: error.message })}\n\n`);
            res.end();
        }

    }

};

// =================================================
// DOWNLOAD TRANSCRIPT
// =================================================

exports.downloadTranscript = async (req, res, next) => {

    try {
        const {
            filename
        } = req.params;

        const safeFilename = filename ?
            path.basename(filename) :
            lastReportStore.getLastTranscript();

        if (!safeFilename) {
            const err = new Error("No transcript has been generated yet");
            err.status = 404;
            throw err;
        }

        if (filename && safeFilename !== filename) {
            const err = new Error("Invalid filename");
            err.status = 400;
            throw err;
        }

        const reportDir = path.join(process.cwd(), process.env.REPORT_DIR || "results");
        const filePath = path.join(reportDir, safeFilename);

        await fs.access(filePath);

        return res.download(filePath, safeFilename);

    } catch (error) {
        if (error.code === 'ENOENT') {
            error.status = 404;
            error.message = "Transcript not found";
        }
        next(error);
    }

};

// =================================================
// DOWNLOAD EXCEL REPORT
// =================================================

exports.downloadReport = async (req, res, next) => {

    try {
        const {
            filename
        } = req.params;

        let safeFilename = filename ?
            path.basename(filename) :
            lastReportStore.getLastReport();

        if (!safeFilename) {
            const reportDir = path.join(process.cwd(), process.env.REPORT_DIR || "results");
            try {
                const files = await fs.readdir(reportDir);
                const xlsxFiles = files.filter((f) => f.endsWith(".xlsx"));
                if (xlsxFiles.length > 0) {
                    xlsxFiles.sort((a, b) => b.localeCompare(a));
                    safeFilename = xlsxFiles[0];
                }
            } catch (err) {
                // Directory read failed, fall through to 404 below
            }
        }

        if (!safeFilename) {
            const err = new Error("No evaluation report has been generated yet");
            err.status = 404;
            throw err;
        }

        if (filename && safeFilename !== filename) {
            const err = new Error("Invalid filename");
            err.status = 400;
            throw err;
        }

        const reportDir = path.join(process.cwd(), process.env.REPORT_DIR || "results");
        const filePath = path.join(reportDir, safeFilename);

        await fs.access(filePath);

        return res.download(filePath, safeFilename);

    } catch (error) {
        if (error.code === 'ENOENT') {
            error.status = 404;
            error.message = "Evaluation report not found";
        }
        next(error);
    }

};

exports.getUploadProgress = async (req, res, next) => {
    try {
        const { uploadId } = req.params;
        const progress = progressStore.getUploadProgress(uploadId);

        if (!progress) {
            const err = new Error("Upload not found");
            err.status = 404;
            throw err;
        }

        return res.status(200).json({
            success: true,
            ...progress
        });
    } catch (error) {
        next(error);
    }
};

// =================================================
// DOWNLOAD BATCH EXCEL REPORT
// =================================================

exports.downloadBatchReport = async (req, res, next) => {
    try {
        const { getBatchFilePath, BATCH_FILENAME } = require("../services/batchReportService");
        const filePath = getBatchFilePath();

        await fs.access(filePath);

        return res.download(filePath, BATCH_FILENAME);
    } catch (error) {
        if (error.code === 'ENOENT') {
            error.status = 404;
            error.message = "Batch evaluation report not found. Upload resumes to generate it.";
        }
        next(error);
    }
};
