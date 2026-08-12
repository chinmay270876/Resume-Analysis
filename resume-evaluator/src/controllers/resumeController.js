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
    evaluateAts
} = require("../services/atsEvaluationService");

const {
    appendCandidate: appendBatchCandidate,
    finalizeBatch: finalizeBatchReport
} = require("../services/batchReportService");

const {
    parseJobDescription
} = require("../services/jdParserService");

const {
    generateInterviewQuestions
} = require("../services/interviewQuestionGenerator");

const {
    rankCandidatesAgainstJd
} = require("../services/candidateRankingService");

const {
    resetWorkbook,
    writeCandidateRanking
} = require("../services/excelService");

const {
    saveTranscript
} = require("../services/transcriptService");

const lastReportStore = require("../utils/lastReportStore");

const {
    sendInterviewInvite,
    isValidEmail
} = require("../services/emailService");
const { assertValidResumeFile } = require("../utils/fileValidation");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs").promises;
const path = require("path");
const progressStore = require("../utils/progressStore");

const MAX_RESUMES = 5;
const MAX_RESUME_CHARS = 15000;
const logVerbose = (...args) => {
    if (process.env.NODE_ENV !== "production") {
        console.log(...args);
    }
};

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

    await assertValidResumeFile(file);

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
    let atsEvaluation;
    let currentStage = "Initialization";

    try {
        // =================================================
        // STEP 1/7: PDF Extraction
        // =================================================

        currentStage = "PDF Extraction";
        logVerbose("Starting PDF extraction...");

        const resumeTextRaw = await timeStage("pdfExtraction", () =>
            extractPdfText(file.path)
        );

        logVerbose("PDF extraction complete.");

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

        currentStage = "Resume Analysis";
        logVerbose("Starting resume analysis...");

        update("Analyzing Resume");

        const rawAnalysis = await timeStage("resumeAnalysis", () =>
            analyzeResume(resumeText)
        );

        logVerbose("Resume analysis complete.");

        if (!rawAnalysis || typeof rawAnalysis !== "object") {
            const err = new Error("Invalid resume analysis response from AI.");
            err.status = 500;
            throw err;
        }

        // Validate + repair the AI response before any downstream step.
        analysis = validateAnalysis(rawAnalysis);

        candidateName = analysis.candidateName || "Unknown_Candidate";

        // =================================================
        // STEP 3/7: Interview Generation + ATS Evaluation (Concurrent)
        // =================================================

        currentStage = "Interview Generation & ATS Evaluation";
        logVerbose("Starting interview generation and ATS evaluation concurrently...");

        update("Generating Interview");

        const atsPromise = timeStage("atsEvaluation", () =>
            evaluateAts(resumeText, analysis)
        ).catch((err) => {
            console.error("ATS evaluation failed (non-fatal):", err.message);
            return null;
        });

        const [generatedTranscript, atsResult] = await Promise.all([
            timeStage("interviewGeneration", () =>
                generateInterview(analysis)
            ),
            atsPromise
        ]);

        interviewTranscript = generatedTranscript;
        atsEvaluation = atsResult;

        logVerbose("Interview generation and ATS evaluation complete.");

        // =================================================
        // STEP 4/7: Save Transcript + Candidate Evaluation (Concurrent)
        // =================================================

        currentStage = "Save Transcript & Evaluation";
        logVerbose("Starting transcript save & candidate evaluation concurrently...");

        update("Evaluating Candidate");

        const [tFilename, evalResult] = await Promise.all([
            timeStage("saveTranscript", () =>
                saveTranscript(interviewTranscript, candidateName, resumeId)
            ),
            timeStage("evaluation", () =>
                evaluateCandidate(interviewTranscript, analysis)
            )
        ]);

        transcriptFilename = tFilename;
        evaluation = evalResult;
        trackFile(path.join(process.cwd(), process.env.REPORT_DIR || "results", transcriptFilename));

        logVerbose("Transcript save and candidate evaluation complete.");

        if (!evaluation || typeof evaluation !== "object") {
            const err = new Error("Invalid evaluation response from AI.");
            err.status = 500;
            throw err;
        }

        // As soon as AI evaluation finishes, append the candidate into the
        // shared batch report (independent of podcast generation / email).
        if (batchToken) {
            try {
                await appendBatchCandidate(batchToken, resumeId, analysis, evaluation, false, atsEvaluation);
            } catch (batchErr) {
                console.error("❌ Batch report append failed:", batchErr.message);
            }
        }

        // =================================================
        // STEP 5/7: Returning Response (immediately)
        // =================================================

        const endTime = Date.now();
        const elapsedSeconds = Math.round((endTime - startTime) / 1000);

        logVerbose(`\n=== PIPELINE TIMINGS (${file.originalname}) ===`);
        logVerbose(`PDF Extraction: ${stageTimings.pdfExtraction}s`);
        logVerbose(`Resume Analysis: ${stageTimings.resumeAnalysis}s`);
        logVerbose(`Interview Generation: ${stageTimings.interviewGeneration}s`);
        logVerbose(`Save Transcript: ${stageTimings.saveTranscript}s`);
        logVerbose(`Evaluation: ${stageTimings.evaluation}s`);
        logVerbose(`Total (pre-response): ${elapsedSeconds}s`);
        logVerbose(`==========================================\n`);

        // Build the response payload. Podcast + reports + email run in the
        // background and are NOT awaited here, so the API returns immediately.
        const responsePayload = {
            success: true,
            filename: file.originalname,
            candidateName: analysis.candidateName || "Unknown",
            email: analysis.email || "",
            evaluation,
            atsEvaluation: atsEvaluation || {
                atsScore: null,
                atsGrade: "",
                atsSummary: "ATS evaluation unavailable",
                atsBreakdown: {},
                missingKeywords: [],
                formatIssues: [],
                recommendations: []
            },
            analysis,
            interviewTranscript,
            transcriptFilename,
            podcastScript: null,
            podcastScriptPath: null,
            podcastPath: null,
            reportFilename: "Resume Evaluation.xlsx",
            reportPath: "Resume Evaluation.xlsx",
            emailSent: false,
            emailSkipped: false,
            emailError: null,
            elapsedSeconds
        };

        logVerbose("📌 [LOG] ATS data before returning API response:", JSON.stringify(responsePayload.atsEvaluation, null, 2));

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
            reportFilename: "Resume Evaluation.xlsx",
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
            if (podcastPath) {
                trackFile(podcastPath);
                responsePayload.podcastPath = podcastPath;
            } else {
                responsePayload.podcastPath = null;
                console.warn(`[Podcast] No audio produced for resume ${resumeId}`);
            }

            const podcastSeconds = Math.round((Date.now() - t0) / 100) / 100;
            logVerbose(`Podcast (background): ${podcastSeconds}s`);
        }).catch(() => { /* logged inside runBackground */ });

        // =================================================
        // STEP 7/7: Reports + Email (Background)
        // =================================================

        runBackground("reports+email", resumeId, update, async () => {
            const t0 = Date.now();

            // Email is non-blocking; failures are logged, never thrown.
            try {
                const resultValue = (evaluation?.result || "").toLowerCase();
                const recommendation = evaluation?.recommendation ? String(evaluation.recommendation).toLowerCase() : "";
                const candidateEmail = analysis.email;

                const positiveResult = resultValue === "pass" || resultValue === "selected" || resultValue === "hire";
                const positiveRecommendation =
                    recommendation.includes("recommended") ||
                    recommendation.includes("selected") ||
                    recommendation.includes("pass");

                // Primary gate: result field (PASS/FAIL). Fallback: recommendation text.
                const shouldSendEmail = positiveResult || (!resultValue && positiveRecommendation);

                if (candidateEmail && shouldSendEmail && isValidEmail(candidateEmail)) {
                    await sendInterviewInvite(analysis.candidateName, candidateEmail, atsEvaluation);
                    responsePayload.emailSent = true;
                    update("Completed", {
                        emailSent: true,
                        emailSkipped: false,
                        emailError: null
                    });
                } else if (!isValidEmail(candidateEmail)) {
                    responsePayload.emailSkipped = true;
                    update("Completed", {
                        emailSent: false,
                        emailSkipped: true,
                        emailError: null
                    });
                } else {
                    update("Completed", {
                        emailSent: false,
                        emailSkipped: false,
                        emailError: null
                    });
                }
            } catch (err) {
                responsePayload.emailError = err.message;
                update("Completed", {
                    emailSent: false,
                    emailSkipped: false,
                    emailError: err.message
                });
            }

            const reportSeconds = Math.round((Date.now() - t0) / 100) / 100;
            logVerbose(`Reports + Email (background): ${reportSeconds}s`);
        }).catch(() => { /* logged inside runBackground */ });

        return responsePayload;
    } catch (error) {
        await Promise.all(createdFiles.map(safeUnlink));

        // Even on failure, record the candidate (with whatever partial data
        // we have) as a FAILED row so the batch report stays complete.
        if (batchToken) {
            try {
                await appendBatchCandidate(batchToken, resumeId, analysis || { candidateName: file.originalname }, null, true, atsEvaluation || null);
            } catch (batchErr) {
                console.error("❌ Batch report failed-row append failed:", batchErr.message);
            }
        }

        console.error(`[FATAL] ${currentStage} failed for ${file.originalname}:`, error);
        console.error(error.stack);

        const err = new Error(`${currentStage} failed: ${error.message}`);
        err.status = error.status || 500;
        err.stage = currentStage;
        err.originalError = error;
        throw err;
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

        logVerbose("-------------------------------------------------");
        logVerbose("Resume uploaded");
        logVerbose("-------------------------------------------------");
        logVerbose("Resume filename:", req.file.filename);
        logVerbose("Resume size:", req.file.size);

        const resumeId = uuidv4();
        const uploadId = resumeId;

        const upload = progressStore.createUpload(uploadId, 1, Date.now());
        progressStore.addResume(uploadId, resumeId, req.file.originalname, req.file.filename);

        const result = await processResumeFile(req.file, resumeId, uploadId, (rid, status, extra) => {
            progressStore.updateResumeStatus(uploadId, rid, status, extra);
        }, resumeId);

        try {
            await finalizeBatchReport(resumeId);
        } catch (batchErr) {
            console.error("❌ Batch report finalize failed:", batchErr.message);
        }

        if (process.env.NODE_ENV !== "production") {
            logVerbose("📌 [LOG] ATS data before returning API response (http):", JSON.stringify(result.atsEvaluation, null, 2));
        }

        return res.status(200).json({

            success: true,

            uploadId,
            resumeId,

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

            atsEvaluation: result.atsEvaluation,

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
    // Hoisted so the catch path can always write without ReferenceError.
    const safeWrite = (data) => {
        try {
            if (!res.writableEnded) {
                res.write(data);
            }
        } catch (writeError) {
            console.error("SSE write error:", writeError.message);
        }
    };

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

        const upload = progressStore.createUpload(uploadId, totalResumes, startTime);

        logVerbose(`\n${"=".repeat(60)}`);
        logVerbose(`BATCH UPLOAD STARTED: ${totalResumes} resumes`);
        logVerbose(`Upload ID: ${uploadId}`);
        logVerbose(`${"=".repeat(60)}\n`);

        const results = [];
        let completed = 0;
        let failed = 0;
        let totalProcessingTimeForFinishedResumes = 0;

        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const resumeId = uuidv4();

            upload.currentResumeIndex = i + 1;

            const resumeRecord = progressStore.addResume(uploadId, resumeId, file.originalname, file.filename);

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
                    progressStore.updateResumeStatus(uploadId, rid, status, extra);

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
                logVerbose(`\n✅ Resume ${i + 1}/${totalResumes} completed: ${file.originalname} (${result.elapsedSeconds}s)\n`);
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

                progressStore.updateResumeStatus(uploadId, resumeId, "Failed", { endTime: Date.now(), elapsedSeconds, error: error.message });

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
            logVerbose(`\n📊 Batch report finalized: ${batchFile}`);
        } catch (batchErr) {
            console.error("❌ Batch report finalize failed:", batchErr.message);
        }

        logVerbose(`\n${"=".repeat(60)}`);
        logVerbose(`BATCH UPLOAD COMPLETED: ${completed} succeeded, ${failed} failed`);
        logVerbose(`Total time: ${overallElapsedSeconds}s`);
        logVerbose(`${"=".repeat(60)}\n`);

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

        // Keep progress in memory for TTL so clients can still poll podcast/email
        // background updates after the SSE stream closes.

    } catch (error) {
        if (!res.headersSent) {
            return next(error);
        }
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

        const reportDir = path.resolve(process.cwd(), process.env.REPORT_DIR || "results");
        const filePath = path.resolve(reportDir, safeFilename);

        if (!filePath.startsWith(reportDir + path.sep)) {
            const err = new Error("Invalid filename");
            err.status = 400;
            throw err;
        }

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
        const safeFilename = "Resume Evaluation.xlsx";
        const reportDir = path.join(process.cwd(), process.env.REPORT_DIR || "results");
        const filePath = path.join(reportDir, safeFilename);

        await fs.access(filePath);

        return res.download(filePath, safeFilename);

    } catch (error) {
        if (error.code === 'ENOENT') {
            error.status = 404;
            error.message = "Evaluation report not found. Upload a resume to generate it.";
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
        const { BATCH_FILENAME, getBatchFilePath } = require("../services/batchReportService");
        const filePath = getBatchFilePath();

        await fs.access(filePath);

        return res.download(filePath, BATCH_FILENAME);
    } catch (error) {
        if (error.code === 'ENOENT') {
            error.status = 404;
            error.message = "Evaluation report not found. Upload a resume to generate it.";
        }
        next(error);
    }
};

// =================================================
// PARSE JOB DESCRIPTION
// =================================================

exports.parseJobDescription = async (req, res, next) => {
    try {
        if (!req.file) {
            const err = new Error("No job description file uploaded");
            err.status = 400;
            throw err;
        }

        await assertValidResumeFile(req.file);

        if (process.env.NODE_ENV !== "production") {
            logVerbose("-------------------------------------------------");
            logVerbose("Job Description uploaded:", req.file.originalname);
            logVerbose("-------------------------------------------------");
        }

        const jdAnalysis = await parseJobDescription(req.file.path);

        return res.status(200).json({
            success: true,
            filename: req.file.originalname,
            jdAnalysis,
        });
    } catch (error) {
        next(error);
    } finally {
        if (req.file && req.file.path) {
            await safeUnlink(req.file.path);
        }
    }
};

// =================================================
// RANK CANDIDATES AGAINST JOB DESCRIPTION
// =================================================

exports.rankCandidates = async (req, res, next) => {
    try {
        const { jdAnalysis, candidates } = req.body || {};

        if (!jdAnalysis || typeof jdAnalysis !== "object") {
            const err = new Error("Job description analysis is required.");
            err.status = 400;
            throw err;
        }

        if (!Array.isArray(candidates) || candidates.length < 1) {
            const err = new Error("At least 1 successfully processed candidate is required for ranking.");
            err.status = 400;
            throw err;
        }

        for (const candidate of candidates) {
            if (!candidate?.analysis || typeof candidate.analysis !== "object") {
                const err = new Error("Each candidate must include pre-extracted analysis data.");
                err.status = 400;
                throw err;
            }
        }

        const { rankings } = await rankCandidatesAgainstJd(jdAnalysis, candidates);

        try {
            await writeCandidateRanking(rankings);
        } catch (excelErr) {
            console.error("❌ Ranking worksheet write failed:", excelErr.message);
        }

        return res.status(200).json({
            success: true,
            candidateRanking: { rankings },
        });
    } catch (error) {
        next(error);
    }
};

// =================================================
// GENERATE STRUCTURED INTERVIEW QUESTIONS (JD-primary + resume personalization)
// =================================================

exports.generateInterviewQuestions = async (req, res, next) => {
    const resumeFile = req.files?.resume?.[0] || null;
    const jdFile = req.files?.jobDescription?.[0] || null;

    try {
        if (!jdFile) {
            const err = new Error("Job description file is required.");
            err.status = 400;
            err.stage = "generate-interview";
            throw err;
        }

        await assertValidResumeFile(jdFile);
        if (resumeFile) {
            await assertValidResumeFile(resumeFile);
        }

        if (process.env.NODE_ENV !== "production") {
            logVerbose("-------------------------------------------------");
            logVerbose("Generate Interview — JD:", jdFile.originalname);
            if (resumeFile) {
                logVerbose("Generate Interview — Resume (personalization):", resumeFile.originalname);
            } else {
                logVerbose("Generate Interview — Resume: not provided (JD-only plan)");
            }
            logVerbose("-------------------------------------------------");
        }

        // Step 1: Parse JD (required). Optionally parse resume for personalization + scheduling metadata.
        let analysis = null;
        const jdAnalysis = await parseJobDescription(jdFile.path);

        if (resumeFile) {
            const resumeTextRaw = await extractPdfText(resumeFile.path);
            if (resumeTextRaw && resumeTextRaw.trim().length > 0) {
                const resumeText = resumeTextRaw.length > MAX_RESUME_CHARS
                    ? resumeTextRaw.substring(0, MAX_RESUME_CHARS)
                    : resumeTextRaw;
                const rawAnalysis = await analyzeResume(resumeText);
                analysis = validateAnalysis(rawAnalysis);
            }
        }

        // Step 2: Interview plan — JD primary, resume personalization + gap questions when available
        const interview = await generateInterviewQuestions(jdAnalysis, analysis);

        return res.status(200).json({
            success: true,
            interview,
            analysis,
            jdAnalysis,
        });
    } catch (error) {
        if (!error.stage) {
            error.stage = "generate-interview";
        }
        next(error);
    } finally {
        await Promise.all([
            resumeFile?.path ? safeUnlink(resumeFile.path) : Promise.resolve(),
            jdFile?.path ? safeUnlink(jdFile.path) : Promise.resolve(),
        ]);
    }
};

// =================================================
// RESET EXCEL REPORT
// =================================================

exports.resetReport = async (req, res, next) => {
    try {
        await resetWorkbook();
        return res.status(200).json({
            success: true,
            message: "Report reset successfully.",
            reportFilename: "Resume Evaluation.xlsx",
        });
    } catch (error) {
        next(error);
    }
};
