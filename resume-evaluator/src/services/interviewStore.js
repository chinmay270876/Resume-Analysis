const path = require("path");
const fsp = require("fs").promises;

const DATA_DIR = process.env.DATA_DIR || "data";
const REPORT_DIR = process.env.REPORT_DIR || "results";
const STORE_FILENAME = "interviews.json";
const STORE_FILEPATH = path.join(process.cwd(), DATA_DIR, STORE_FILENAME);
const LEGACY_STORE_FILEPATH = path.join(process.cwd(), REPORT_DIR, STORE_FILENAME);

let storeMutex = Promise.resolve();
let migrated = false;

async function migrateLegacyStoreIfNeeded() {
    if (migrated) return;
    migrated = true;

    try {
        await fsp.access(STORE_FILEPATH);
        return; // already in private data dir
    } catch {
        // continue — try legacy location
    }

    try {
        await fsp.access(LEGACY_STORE_FILEPATH);
        await fsp.mkdir(path.dirname(STORE_FILEPATH), { recursive: true });
        await fsp.copyFile(LEGACY_STORE_FILEPATH, STORE_FILEPATH);
        console.log(`📦 Migrated interviews store from ${LEGACY_STORE_FILEPATH} to ${STORE_FILEPATH}`);
    } catch {
        // no legacy file — ensureStoreFile will create empty store
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
            return { interviews: [] };
        }
        return parsed;
    } catch {
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
    await fsp.writeFile(STORE_FILEPATH, payload, "utf8");
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
};
