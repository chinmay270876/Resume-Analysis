// Tracks the most recently generated report/transcript filenames so the
// download endpoints can serve the "latest" file when called without an
// explicit filename (per the documented API: GET /api/download-report).

let lastReportFilename = null;
let lastTranscriptFilename = null;

function setLastReport(filename) {
    if (filename) {
        lastReportFilename = filename;
    }
}

function setLastTranscript(filename) {
    if (filename) {
        lastTranscriptFilename = filename;
    }
}

function getLastReport() {
    return lastReportFilename;
}

function getLastTranscript() {
    return lastTranscriptFilename;
}

module.exports = {
    setLastReport,
    setLastTranscript,
    getLastReport,
    getLastTranscript,
};
