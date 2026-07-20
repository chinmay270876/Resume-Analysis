const uploads = new Map();

const UPLOAD_TTL = 60 * 60 * 1000;

const STATUS_PERCENTAGE = {
    "Queued": 10,
    "Extracting Text": 20,
    "Analyzing Resume": 30,
    "Generating Interview": 40,
    "Saving Transcript": 50,
    "Generating Podcast Script": 60,
    "Generating Podcast": 70,
    "Evaluating Candidate": 80,
    "Generating Report": 90,
    "Completed": 100,
    "Failed": 0
};

setInterval(() => {
    const now = Date.now();
    for (const [uploadId, upload] of uploads.entries()) {
        if (now - upload.startTime > UPLOAD_TTL) {
            uploads.delete(uploadId);
        }
    }
}, 5 * 60 * 1000);

function createUpload(uploadId, totalResumes, startTime) {
    const upload = {
        uploadId,
        totalResumes,
        startTime,
        currentResumeIndex: 0,
        resumes: new Map(),
        completed: 0,
        failed: 0
    };
    uploads.set(uploadId, upload);
    return upload;
}

function addResume(uploadId, resumeId, filename, originalFilename) {
    const upload = uploads.get(uploadId);
    if (!upload) {
        throw new Error("Upload not found");
    }
    const resume = {
        resumeId,
        filename,
        originalFilename,
        status: "Queued",
        progress: STATUS_PERCENTAGE["Queued"],
        elapsedSeconds: null,
        error: null
    };
    upload.resumes.set(resumeId, resume);
    return resume;
}

function updateResumeStatus(uploadId, resumeId, status, extra = {}) {
    const upload = uploads.get(uploadId);
    if (!upload) return;
    const resume = upload.resumes.get(resumeId);
    if (!resume) return;

    // Once a resume reaches a terminal state (Completed/Failed) its status is
    // final. Background tasks (podcast/report/email) emit intermediate statuses
    // that must NOT move a finished resume backwards (e.g. back to
    // "Generating Podcast"). Ignore any non-terminal update after completion.
    if (resume.status === "Completed" || resume.status === "Failed") {
        return;
    }
    
    resume.status = status;
    resume.progress = STATUS_PERCENTAGE[status] || 0;
    
    if (extra.endTime !== undefined) {
        resume.endTime = extra.endTime;
    }
    if (extra.elapsedSeconds !== undefined) {
        resume.elapsedSeconds = extra.elapsedSeconds;
    }
    if (extra.error !== undefined) {
        resume.error = extra.error;
    }
    
    if (status === "Completed" || status === "Failed") {
        if (status === "Failed") {
            upload.failed++;
        } else {
            upload.completed++;
        }
    }
}

function getUploadProgress(uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload) return null;
    
    const resumes = Array.from(upload.resumes.values()).map(r => ({
        resumeId: r.resumeId,
        filename: r.originalFilename || r.filename,
        status: r.status,
        progress: r.progress,
        elapsedSeconds: r.elapsedSeconds,
        error: r.error
    }));
    
    const finishedResumes = upload.completed + upload.failed;
    const overallProgress = upload.totalResumes > 0 
        ? Math.round((finishedResumes / upload.totalResumes) * 100) 
        : 0;
    
    return {
        uploadId: upload.uploadId,
        totalResumes: upload.totalResumes,
        completed: upload.completed,
        failed: upload.failed,
        overallProgress,
        resumes
    };
}

function cleanupUpload(uploadId) {
    uploads.delete(uploadId);
}

module.exports = {
    createUpload,
    addResume,
    updateResumeStatus,
    getUploadProgress,
    cleanupUpload,
    STATUS_PERCENTAGE
};
