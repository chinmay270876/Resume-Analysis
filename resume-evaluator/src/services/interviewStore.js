const path = require("path");
const fsp = require("fs").promises;

const DATA_DIR = process.env.DATA_DIR || "data";
const REPORT_DIR = process.env.REPORT_DIR || "results";
const STORE_FILENAME = "interviews.json";
// Anchor to this package root (resume-evaluator/), not process.cwd(), so the
// scheduler and HTTP create/update paths always share the same JSON store
// even when the process is launched from start-all/ or the monorepo root.
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const STORE_FILEPATH = path.join(PROJECT_ROOT, DATA_DIR, STORE_FILENAME);
const LEGACY_STORE_FILEPATH = path.join(PROJECT_ROOT, REPORT_DIR, STORE_FILENAME);

let storeMutex = Promise.resolve();
let migrated = false;

async function readInterviewCount(filepath) {
    try {
        const raw = await fsp.readFile(filepath, "utf8");
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed?.interviews) ? parsed.interviews.length : 0;
    } catch {
        return -1; // missing or unreadable
    }
}

async function migrateLegacyStoreIfNeeded() {
    if (migrated) return;
    migrated = true;

    let canonicalCount = -1;
    try {
        await fsp.access(STORE_FILEPATH);
        canonicalCount = await readInterviewCount(STORE_FILEPATH);
    } catch {
        canonicalCount = -1;
    }

    // Already have interviews in the canonical store — nothing to migrate.
    if (canonicalCount > 0) {
        return;
    }

    try {
        await fsp.access(LEGACY_STORE_FILEPATH);
    } catch {
        return; // no legacy file
    }

    const legacyCount = await readInterviewCount(LEGACY_STORE_FILEPATH);
    // Migrate when canonical is missing/empty and legacy has rows.
    // Previously an empty data/interviews.json blocked migration forever.
    if (legacyCount > 0) {
        await fsp.mkdir(path.dirname(STORE_FILEPATH), { recursive: true });
        await fsp.copyFile(LEGACY_STORE_FILEPATH, STORE_FILEPATH);
        console.log(
            `📦 Migrated interviews store from ${LEGACY_STORE_FILEPATH} to ${STORE_FILEPATH} (${legacyCount} interview(s))`
        );
    }
}

async function ensureStoreFile() {
    await migrateLegacyStoreIfNeeded();
    await fsp.mkdir(path.dirname(STORE_FILEPATH), { recursive: true });
    try {
        await fsp.access(STORE_FILEPATH);
    } catch {
        await fsp.writeFile(STORE_FILEPATH, JSON.stringify({ interviews: [] }, null, 2), "utf8");
    }
}

async function readStore() {
    await ensureStoreFile();
    const raw = await fsp.readFile(STORE_FILEPATH, "utf8");
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.interviews)) {
            console.error(
                `[InterviewStore] Invalid store shape at ${STORE_FILEPATH}; expected { interviews: [] }`
            );
            return { interviews: [] };
        }
        return parsed;
    } catch (err) {
        console.error(
            `[InterviewStore] Failed to parse ${STORE_FILEPATH}: ${err.message}`
        );
        return { interviews: [] };
    }
}

async function writeStore(store) {
    await ensureStoreFile();
    const payload = JSON.stringify(
        { interviews: Array.isArray(store.interviews) ? store.interviews : [] },
        null,
        2
    );
    // Atomic write: temp file + rename to avoid corrupt/empty JSON on crash.
    const tmpPath = `${STORE_FILEPATH}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmpPath, payload, "utf8");
    await fsp.rename(tmpPath, STORE_FILEPATH);
}

function withMutex(fn) {
    const nextTask = storeMutex.then(() => fn());
    storeMutex = nextTask.catch(() => {});
    return nextTask;
}

async function getAllInterviews() {
    return withMutex(async () => {
        const store = await readStore();
        return store.interviews.slice();
    });
}

async function getInterviewById(id) {
    return withMutex(async () => {
        const store = await readStore();
        return store.interviews.find((item) => item.id === id) || null;
    });
}

async function createInterview(record) {
    return withMutex(async () => {
        const store = await readStore();
        store.interviews.push(record);
        await writeStore(store);
        return record;
    });
}

async function updateInterview(id, updater) {
    return withMutex(async () => {
        const store = await readStore();
        const index = store.interviews.findIndex((item) => item.id === id);
        if (index === -1) {
            return null;
        }
        const current = store.interviews[index];
        const next = typeof updater === "function" ? updater(current) : { ...current, ...updater };
        store.interviews[index] = next;
        await writeStore(store);
        return next;
    });
}

async function deleteInterview(id) {
    return withMutex(async () => {
        const store = await readStore();
        const index = store.interviews.findIndex((item) => item.id === id);
        if (index === -1) {
            return false;
        }
        store.interviews.splice(index, 1);
        await writeStore(store);
        return true;
    });
}

async function replaceAllInterviews(interviews) {
    return withMutex(async () => {
        await writeStore({ interviews: Array.isArray(interviews) ? interviews : [] });
        return true;
    });
}

module.exports = {
    getAllInterviews,
    getInterviewById,
    createInterview,
    updateInterview,
    deleteInterview,
    replaceAllInterviews,
    STORE_FILEPATH,
    PROJECT_ROOT,
};
