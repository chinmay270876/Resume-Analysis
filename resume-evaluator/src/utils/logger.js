/**
 * Lightweight structured logging. Verbose info logs are suppressed in production.
 */
const isProduction = () => process.env.NODE_ENV === "production";

function formatArgs(level, args) {
    const ts = new Date().toISOString();
    return [`[${ts}] [${level}]`, ...args];
}

const logger = {
    info(...args) {
        if (!isProduction()) {
            console.log(...formatArgs("INFO", args));
        }
    },
    warn(...args) {
        console.warn(...formatArgs("WARN", args));
    },
    error(...args) {
        console.error(...formatArgs("ERROR", args));
    },
    /** Always emit (startup, critical operational messages). */
    always(...args) {
        console.log(...formatArgs("INFO", args));
    },
};

module.exports = { logger };
