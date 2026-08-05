/**
 * Podcast Transcript Module — storage & formatting for REAL live-interview transcripts.
 *
 * Transcripts are NEVER pre-generated or invented. Voice AI providers (Zeko, OpenAI
 * Realtime, LiveKit, Twilio, WebRTC, Deepgram, AssemblyAI, Whisper, etc.) must submit
 * the actual conversation turns (timestamp, speaker, text) after the session ends.
 */

const fsp = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const {
    EVALUATION_STATUSES,
} = require("../models/interviewStatuses");

const SPEAKERS = Object.freeze({
    AI: "AI",
    CANDIDATE: "Candidate",
});

function createHttpError(message, status = 400, stage = "podcast-transcript") {
    const err = new Error(message);
    err.status = status;
    err.stage = stage;
    return err;
}

function getDataDir() {
    return path.join(process.cwd(), process.env.DATA_DIR || "data");
}

function getTranscriptsDir() {
    return path.join(getDataDir(), "transcripts");
}

function getTranscriptTxtDir() {
    return path.join(process.cwd(), process.env.REPORT_DIR || "results", "interview-transcripts");
}

function transcriptJsonPath(interviewId) {
    return path.join(getTranscriptsDir(), `${interviewId}.json`);
}

function normalizeSpeaker(raw) {
    const value = String(raw || "")
        .trim()
        .toLowerCase();
    if (!value) return null;

    if (
        value === "ai" ||
        value === "interviewer" ||
        value === "assistant" ||
        value === "agent" ||
        value === "voice ai" ||
        value === "voice ai agent" ||
        value === "bot"
    ) {
        return SPEAKERS.AI;
    }

    if (
        value === "candidate" ||
        value === "user" ||
        value === "human" ||
        value === "applicant" ||
        value === "interviewee"
    ) {
        return SPEAKERS.CANDIDATE;
    }

    return null;
}

/**
 * Normalize a single provider turn into { timestamp, speaker, text }.
 * Accepts common aliases: time, ts, start; message, content, utterance.
 */
function normalizeLine(raw, index) {
    if (!raw || typeof raw !== "object") {
        throw createHttpError(`Transcript line ${index + 1} is invalid.`);
    }

    const speaker = normalizeSpeaker(raw.speaker ?? raw.role ?? raw.speakerLabel);
    if (!speaker) {
        throw createHttpError(
            `Transcript line ${index + 1}: speaker must be "AI" or "Candidate".`
        );
    }

    const text = String(raw.text ?? raw.message ?? raw.content ?? raw.utterance ?? "").trim();
    if (!text) {
        throw createHttpError(`Transcript line ${index + 1}: message text is required.`);
    }

    let timestamp = String(raw.timestamp ?? raw.time ?? raw.ts ?? "").trim();
    if (!timestamp && (raw.start != null || raw.offsetSeconds != null)) {
        timestamp = formatTimestamp(Number(raw.start ?? raw.offsetSeconds) || 0);
    }
    if (!timestamp) {
        timestamp = formatTimestamp(index * 5);
    }

    return { timestamp, speaker, text };
}

function formatTimestamp(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function parseTimestampToSeconds(timestamp) {
    if (timestamp == null) return null;
    const parts = String(timestamp)
        .trim()
        .split(":")
        .map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n))) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
}

function countWords(lines) {
    return lines.reduce((sum, line) => {
        const words = String(line.text || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
        return sum + words.length;
    }, 0);
}

function estimateDurationSeconds(lines, explicitDuration) {
    if (explicitDuration != null && Number.isFinite(Number(explicitDuration))) {
        return Math.max(0, Math.round(Number(explicitDuration)));
    }
    let max = 0;
    for (const line of lines) {
        const sec = parseTimestampToSeconds(line.timestamp);
        if (sec != null && sec > max) max = sec;
    }
    return max;
}

function formatDurationLabel(durationSeconds, scheduledMinutes) {
    if (durationSeconds != null && Number.isFinite(Number(durationSeconds))) {
        const total = Math.round(Number(durationSeconds));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}m ${String(s).padStart(2, "0")}s`;
    }
    if (scheduledMinutes != null) {
        return `${scheduledMinutes} minutes (scheduled)`;
    }
    return "—";
}

/**
 * Professional podcast transcript text — full conversation, never summarized.
 * Optional interview context adds candidate / role / schedule metadata.
 */
function formatPlainText(transcript, interview = null) {
    const jobRole =
        interview?.jobRole ||
        interview?.jobDescription?.jobTitle ||
        interview?.resumeSummary?.role ||
        "—";
    const candidateName =
        interview?.candidateName ||
        interview?.resumeSummary?.candidateName ||
        "—";
    const interviewDate = interview?.date || interview?.interviewDate || "—";
    const interviewTime = interview?.time || interview?.interviewTime || "";

    const header = [
        "═══════════════════════════════════════",
        "     PODCAST INTERVIEW TRANSCRIPT",
        "═══════════════════════════════════════",
        "",
        "CANDIDATE INFORMATION",
        `Candidate: ${candidateName}`,
        `Email: ${interview?.candidateEmail || "—"}`,
        `Job Role: ${jobRole}`,
        `Current Company: ${interview?.currentCompany || interview?.resumeSummary?.currentCompany || "—"}`,
        `Interview ID: ${transcript.interviewId}`,
        `Transcript ID: ${transcript.transcriptId}`,
        `Candidate ID: ${transcript.candidateId || "—"}`,
        "",
        "INTERVIEW METADATA",
        `Interview Date: ${interviewDate}${interviewTime ? ` ${interviewTime}` : ""}`.trim(),
        `Timezone: ${interview?.timezone || "—"}`,
        `Interview Duration: ${formatDurationLabel(transcript.duration, interview?.durationMinutes)}`,
        `Word Count: ${transcript.wordCount ?? 0}`,
        `Created: ${transcript.createdAt}`,
        `Provider: ${transcript.provider || "Voice AI (provider-agnostic)"}`,
        "",
        "───────────────────────────────────────",
        "TRANSCRIPT",
        "(Timestamp · Speaker · Message)",
        "───────────────────────────────────────",
        "",
    ];

    const body = (transcript.lines || []).flatMap((line) => [
        line.timestamp,
        line.speaker,
        line.text,
        "",
    ]);

    return [...header, ...body].join("\n");
}

/**
 * Minimal multi-page text PDF (no external dependency).
 */
function buildSimplePdf(title, plainText) {
    const lines = String(plainText || "").split(/\r?\n/);
    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const fontSize = 10;
    const lineHeight = 14;
    const maxChars = 90;
    const usableHeight = pageHeight - margin * 2;
    const linesPerPage = Math.floor(usableHeight / lineHeight);

    const wrapped = [];
    for (const line of lines) {
        if (!line) {
            wrapped.push("");
            continue;
        }
        let remaining = line.replace(/[^\x20-\x7E]/g, "?");
        while (remaining.length > maxChars) {
            let breakAt = remaining.lastIndexOf(" ", maxChars);
            if (breakAt < 20) breakAt = maxChars;
            wrapped.push(remaining.slice(0, breakAt));
            remaining = remaining.slice(breakAt).trimStart();
        }
        wrapped.push(remaining);
    }

    const pages = [];
    for (let i = 0; i < wrapped.length; i += linesPerPage) {
        pages.push(wrapped.slice(i, i + linesPerPage));
    }
    if (pages.length === 0) pages.push([title || "Transcript"]);

    const objects = [];
    const addObj = (content) => {
        objects.push(content);
        return objects.length;
    };

    const kids = [];
    const contentIds = [];

    for (const pageLines of pages) {
        const streamParts = [
            "BT",
            `/F1 ${fontSize} Tf`,
            `${margin} ${pageHeight - margin} Td`,
            `${lineHeight} TL`,
        ];
        for (const line of pageLines) {
            const escaped = line
                .replace(/\\/g, "\\\\")
                .replace(/\(/g, "\\(")
                .replace(/\)/g, "\\)");
            streamParts.push(`(${escaped}) Tj`, "T*");
        }
        streamParts.push("ET");
        const stream = streamParts.join("\n");
        const contentId = addObj(
            `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
        );
        contentIds.push(contentId);
    }

    const fontId = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

    for (let i = 0; i < pages.length; i++) {
        const pageId = addObj(
            `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
        );
        kids.push(pageId);
    }

    const kidsRef = kids.map((id) => `${id} 0 R`).join(" ");
    const pagesId = addObj(`<< /Type /Pages /Kids [ ${kidsRef} ] /Count ${kids.length} >>`);

    // Patch Parent references now that pages object id is known
    for (const pageId of kids) {
        objects[pageId - 1] = objects[pageId - 1].replace("/Parent 0 0 R", `/Parent ${pagesId} 0 R`);
    }

    const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (let i = 0; i < objects.length; i++) {
        offsets.push(Buffer.byteLength(pdf, "utf8"));
        pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, "utf8");
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += "0000000000 65535 f \n";
    for (let i = 1; i <= objects.length; i++) {
        pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
    pdf += `startxref\n${xrefOffset}\n%%EOF`;
    return Buffer.from(pdf, "utf8");
}

/**
 * Persist a real transcript from a completed Voice AI session.
 * Rejects empty / missing turns — never invents conversation content.
 */
async function createTranscriptFromLiveSession({
    interviewId,
    candidateId,
    lines: rawLines,
    audioFilePath = null,
    durationSeconds = null,
    provider = null,
}) {
    if (!interviewId) {
        throw createHttpError("Interview ID is required.");
    }
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
        throw createHttpError(
            "Transcript lines are required from the live interview. Transcripts are never pre-generated."
        );
    }

    const lines = rawLines.map((line, index) => normalizeLine(line, index));
    const transcriptId = uuidv4();
    const createdAt = new Date().toISOString();
    const wordCount = countWords(lines);
    const duration = estimateDurationSeconds(lines, durationSeconds);

    await fsp.mkdir(getTranscriptsDir(), { recursive: true });
    await fsp.mkdir(getTranscriptTxtDir(), { recursive: true });

    const safeId = String(interviewId).replace(/[^a-zA-Z0-9-_]/g, "");
    const txtFileName = `${safeId}_podcast_transcript.txt`;
    const transcriptFilePath = path.join(getTranscriptTxtDir(), txtFileName);

    const safeAudioPath = sanitizeAudioFilePath(audioFilePath);

    const record = {
        transcriptId,
        interviewId,
        candidateId: candidateId || interviewId,
        lines,
        createdAt,
        duration,
        wordCount,
        audioFilePath: safeAudioPath,
        transcriptFilePath,
        evaluationStatus: EVALUATION_STATUSES.PENDING,
        provider: provider || null,
    };

    const plainText = formatPlainText(record);
    await fsp.writeFile(transcriptFilePath, plainText, "utf8");
    await fsp.writeFile(transcriptJsonPath(interviewId), JSON.stringify(record, null, 2), "utf8");

    console.log("[PodcastTranscript] Stored real interview transcript", {
        transcriptId,
        interviewId,
        lineCount: lines.length,
        wordCount,
        duration,
    });

    return record;
}

async function getTranscriptByInterviewId(interviewId) {
    if (!interviewId) return null;
    try {
        const raw = await fsp.readFile(transcriptJsonPath(interviewId), "utf8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
    }
}

async function updateTranscript(interviewId, patch) {
    const existing = await getTranscriptByInterviewId(interviewId);
    if (!existing) {
        throw createHttpError("Transcript not found for this interview.", 404);
    }
    const next = {
        ...existing,
        ...patch,
        transcriptId: existing.transcriptId,
        interviewId: existing.interviewId,
        lines: existing.lines,
        updatedAt: new Date().toISOString(),
    };
    await fsp.writeFile(transcriptJsonPath(interviewId), JSON.stringify(next, null, 2), "utf8");
    return next;
}

/**
 * Search transcript by keyword, speaker, and/or timestamp substring.
 */
function searchTranscript(transcript, { q, speaker, timestamp } = {}) {
    if (!transcript?.lines?.length) {
        return [];
    }

    const query = String(q || "").trim().toLowerCase();
    const speakerFilter = speaker ? normalizeSpeaker(speaker) : null;
    const tsFilter = String(timestamp || "").trim().toLowerCase();

    return transcript.lines.filter((line) => {
        if (speakerFilter && line.speaker !== speakerFilter) return false;
        if (tsFilter && !String(line.timestamp).toLowerCase().includes(tsFilter)) return false;
        if (query) {
            const haystack = `${line.timestamp} ${line.speaker} ${line.text}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        return true;
    });
}

function toPublicTranscript(transcript, { lines = null } = {}) {
    if (!transcript) return null;
    return {
        transcriptId: transcript.transcriptId,
        interviewId: transcript.interviewId,
        candidateId: transcript.candidateId,
        lines: lines != null ? lines : transcript.lines,
        createdAt: transcript.createdAt,
        duration: transcript.duration,
        wordCount: transcript.wordCount,
        audioFilePath: transcript.audioFilePath,
        transcriptFilePath: transcript.transcriptFilePath
            ? `/api/interviews/${transcript.interviewId}/transcript/download?format=txt`
            : null,
        evaluationStatus: transcript.evaluationStatus,
        provider: transcript.provider || null,
        lineCount: (lines != null ? lines : transcript.lines)?.length || 0,
    };
}

async function getTranscriptDownloadBuffer(interviewId, format = "txt", interview = null) {
    const transcript = await getTranscriptByInterviewId(interviewId);
    if (!transcript) {
        throw createHttpError("No transcript available yet.", 404);
    }

    const plainText = formatPlainText(transcript, interview);
    const baseName = `${interviewId}_podcast_transcript`;

    if (format === "pdf") {
        return {
            buffer: buildSimplePdf("Podcast Interview Transcript", plainText),
            contentType: "application/pdf",
            filename: `${baseName}.pdf`,
        };
    }

    return {
        buffer: Buffer.from(plainText, "utf8"),
        contentType: "text/plain; charset=utf-8",
        filename: `${baseName}.txt`,
    };
}

/**
 * Returns true when candidate resolves inside root (no path traversal).
 */
function isPathInside(root, candidate) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    return (
        resolvedCandidate === resolvedRoot ||
        resolvedCandidate.startsWith(resolvedRoot + path.sep)
    );
}

function getAllowedAudioRoots() {
    const outputDir = path.resolve(process.cwd(), process.env.OUTPUT_DIR || "output");
    const dataDir = path.resolve(getDataDir());
    const recordingsDir = path.join(dataDir, "recordings");
    const reportDir = path.resolve(process.cwd(), process.env.REPORT_DIR || "results");
    return [outputDir, recordingsDir, reportDir];
}

/**
 * Sanitize user/provider-supplied audio paths before persistence.
 * Rejects traversal and paths outside allowed media directories.
 * Returns a relative (cwd) or basename-safe path, or null.
 */
function sanitizeAudioFilePath(audioFilePath) {
    if (!audioFilePath || typeof audioFilePath !== "string") return null;

    const trimmed = audioFilePath.trim();
    if (!trimmed || trimmed.includes("\0")) return null;

    const allowedRoots = getAllowedAudioRoots();
    let resolved;

    if (path.isAbsolute(trimmed)) {
        resolved = path.resolve(trimmed);
    } else {
        const cleaned = trimmed.replace(/^[/\\]+/, "");
        if (!cleaned || cleaned.split(/[/\\]/).includes("..")) return null;
        resolved = path.resolve(process.cwd(), cleaned);
    }

    if (!allowedRoots.some((root) => isPathInside(root, resolved))) {
        return null;
    }

    return path.relative(process.cwd(), resolved).replace(/\\/g, "/");
}

/**
 * Resolve a stored audio reference to candidate absolute paths under allowed dirs only.
 * Never returns arbitrary absolute paths from untrusted input.
 */
function resolveAudioAbsolutePath(audioFilePath) {
    if (!audioFilePath || typeof audioFilePath !== "string") return null;

    const allowedRoots = getAllowedAudioRoots();
    const outputDir = allowedRoots[0];
    const recordingsDir = allowedRoots[1];
    const reportDir = allowedRoots[2];
    const candidates = [];

    if (path.isAbsolute(audioFilePath)) {
        const resolved = path.resolve(audioFilePath);
        if (allowedRoots.some((root) => isPathInside(root, resolved))) {
            return [resolved];
        }
        return null;
    }

    const cleaned = audioFilePath.replace(/^[/\\]+/, "");
    if (!cleaned || cleaned.split(/[/\\]/).includes("..")) return null;

    const relativeCandidate = path.resolve(process.cwd(), cleaned);
    if (allowedRoots.some((root) => isPathInside(root, relativeCandidate))) {
        candidates.push(relativeCandidate);
    }

    const base = path.basename(cleaned);
    if (base && base !== "." && base !== "..") {
        candidates.push(
            path.join(outputDir, base),
            path.join(recordingsDir, base),
            path.join(reportDir, base)
        );
    }

    // Deduplicate while preserving order
    return [...new Set(candidates)];
}

module.exports = {
    SPEAKERS,
    createTranscriptFromLiveSession,
    getTranscriptByInterviewId,
    updateTranscript,
    searchTranscript,
    toPublicTranscript,
    getTranscriptDownloadBuffer,
    formatPlainText,
    buildSimplePdf,
    formatTimestamp,
    normalizeSpeaker,
    normalizeLine,
    sanitizeAudioFilePath,
    resolveAudioAbsolutePath,
};
