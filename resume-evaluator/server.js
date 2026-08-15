require("dotenv").config();

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (process.env.NODE_ENV !== "production") {
    console.log("[ENV CHECK] OPENAI_API_KEY loaded?", !!OPENAI_KEY, "| Length:", OPENAI_KEY?.length, "| Starts with 'sk-':", OPENAI_KEY?.startsWith("sk-"));
}

const express = require("express");
const cors = require("cors");
const path = require("path");
const { apiKeyAuth } = require("./src/middleware/apiKeyAuth");

const app = express();

const PORT = process.env.PORT || 3000;

// ================================
// Trust Proxy (for correct client IP behind reverse proxy)
// ================================

app.set("trust proxy", 1);

// ================================
// Environment Validation
// ================================

if (!process.env.OPENAI_API_KEY) {

    console.error(
        "\x1b[31m%s\x1b[0m",
        "CRITICAL ERROR: OPENAI_API_KEY missing"
    );

    process.exit(1);

}

if (process.env.NODE_ENV === "production" && !process.env.API_KEY) {
    console.error(
        "\x1b[33m%s\x1b[0m",
        "WARNING: API_KEY is not set in production. /api routes are publicly accessible. Set API_KEY and configure the frontend apiKey / __env.API_KEY to protect the API."
    );
}

// ================================
// CORS
// ================================

const isRender = !!process.env.RENDER;
const hideErrorDetails =
    process.env.NODE_ENV === "production" || isRender;

const defaultOrigins = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
    "http://localhost:4000",
    "http://127.0.0.1:4000",

    "https://resume-analysis-d9mf.onrender.com",
    "https://resume-analysis-b7p7.onrender.com",
];

// Merge env origins with defaults. Previously CORS_ORIGINS *replaced*
// defaults, which blocked the deployed Render frontend when .env only
// listed localhost — scheduling requests never reached this API from prod UI.
const envOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
function originFromUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
        return new URL(raw).origin;
    } catch {
        return raw.replace(/\/$/, "");
    }
}
const frontendOrigin = originFromUrl(process.env.FRONTEND_URL);
const allowedOrigins = [...new Set([
    ...defaultOrigins,
    ...envOrigins,
    ...(frontendOrigin ? [frontendOrigin] : []),
])];

app.use(cors({
    origin(origin, callback) {

        if (process.env.NODE_ENV !== "production") {
            console.log("====================================");
            console.log("Incoming Origin:", origin);
            console.log("Allowed Origins:", allowedOrigins);
            console.log("====================================");
        }

        // In production, reject credentialed browser requests with no Origin.
        // Non-browser clients (curl, server-to-server) typically omit Origin —
        // those must use API_KEY when configured rather than open CORS.
        if (!origin) {
            if (process.env.NODE_ENV === "production") {
                return callback(null, false);
            }
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            if (process.env.NODE_ENV !== "production") {
                console.log("✅ Origin Allowed");
            }
            return callback(null, true);
        }

        if (process.env.NODE_ENV !== "production") {
            console.log("❌ Origin Blocked");
        }

        return callback(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
}));

// ================================
// Security Headers
// ================================

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(self), camera=(self)");
    if (process.env.NODE_ENV === "production") {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        res.setHeader(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https://api.openai.com https://*.100ms.live wss://*.100ms.live https://*.live-video.net; font-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
        );
    }
    next();
});

// ================================
// Static File Serving (output only)
// ================================
// results/ is intentionally NOT served statically — it holds PII (Excel,
// transcripts) and must be accessed only via authenticated download APIs.
// output/ hosts podcast audio with UUID filenames. In production, require the same
// API_KEY (header or ?api_key=) so media is not anonymously enumerable.

const outputDirName = process.env.OUTPUT_DIR || "output";
const outputStatic = express.static(path.join(process.cwd(), outputDirName), {
    fallthrough: false,
    index: false,
    dotfiles: "deny",
});

app.use(`/${outputDirName}`, (req, res, next) => {
    if (process.env.API_KEY) {
        return apiKeyAuth(req, res, (err) => {
            if (err) return next(err);
            return outputStatic(req, res, next);
        });
    }
    return outputStatic(req, res, next);
});

// ================================
// Simple In-Memory Rate Limiter
// ================================

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 100;
let rateLimitInterval;

function cleanupRateLimiter() {
    const now = Date.now();
    for (const [key, record] of rateLimitMap.entries()) {
        if (now - record.windowStart > RATE_LIMIT_WINDOW) {
            rateLimitMap.delete(key);
        }
    }
}

rateLimitInterval = setInterval(cleanupRateLimiter, 5 * 60 * 1000);

app.use((req, res, next) => {
    const key = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    const record = rateLimitMap.get(key);

    if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(key, { count: 1, windowStart: now });
        return next();
    }

    record.count++;

    if (record.count > RATE_LIMIT_MAX) {
        return res.status(429).json({
            success: false,
            error: "Too many requests, please try again later."
        });
    }

    next();
});

// ================================
// Middleware
// ================================

app.use(express.json({
    limit: "10mb",
    verify(req, _res, buf) {
        if (req.originalUrl && /\/api\/100ms\/webhook\/?$/.test(req.originalUrl.split("?")[0])) {
            req.rawBody = Buffer.from(buf || "");
        }
    },
}));

app.use(express.urlencoded({
    extended: true,
    limit: "10mb"
}));

// ================================
// Request Logger
// ================================

if (process.env.NODE_ENV !== "production") {
    app.use((req, res, next) => {
        console.log(`${req.method} ${req.url}`);
        next();
    });
}

// ================================
// Health Route
// ================================

app.get("/", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Resume Evaluator API Running"
    });
});

app.get("/api/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Resume Evaluator API Running",
        service: "resume-evaluator",
        runtime: "node",
    });
});

// ================================
// Routes
// ================================

const resumeRoutes =
    require("./src/routes/resumeRoutes");
const interviewRoutes =
    require("./src/routes/interviewRoutes");

// Opt-in: when API_KEY is set, all /api routes require it. Response shapes unchanged.
// GET /api/health is registered above and remains public for uptime checks.
const { handleHmsWebhook } = require("./src/controllers/interviewController");
app.post("/api/100ms/webhook", handleHmsWebhook);

app.use("/api", apiKeyAuth);
app.use("/api", resumeRoutes);
app.use("/api/interviews", interviewRoutes);

// ================================
// 404 Handler
// ================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Route not found"
    });
});

// ================================
// Error Handler
// ================================

app.use((err, req, res, next) => {
    console.error(err);
    if (err?.stack) {
        console.error(err.stack);
    }

    const status = err.status || 500;
    // Keep intentional 4xx messages (validation / not found) even in production.
    const clientSafe =
        status >= 400 &&
        status < 500 &&
        typeof err.message === "string" &&
        err.message.trim().length > 0;

    res.status(status).json({
        success: false,
        error: clientSafe
            ? err.message
            : hideErrorDetails
                ? "Something went wrong"
                : err.message,
        code: err.code || undefined,
        stage: err.stage || "Unknown",
        stack: hideErrorDetails ? undefined : err.stack,
    });
});

// ================================
// Graceful Shutdown
// ================================

const {
    startReminderScheduler,
    stopReminderScheduler,
} = require("./src/services/interviewReminderService");
const {
    warnIfEmailEnvMissing,
    ensureTransporterVerified,
} = require("./src/services/emailService");
const progressStore = require("./src/utils/progressStore");

const server = app.listen(PORT, () => {
    console.log(`🚀 Server Running on port ${PORT}`);

    if (process.env.RENDER_EXTERNAL_URL) {
        console.log(`📌 API URL: ${process.env.RENDER_EXTERNAL_URL}`);
        console.warn(
            "⚠️  Render ephemeral disk: interviews/results/uploads reset on redeploy unless a persistent disk is attached."
        );
        console.warn(
            "⚠️  Free-tier spin-down pauses the in-process reminder scheduler. Use a paid instance or Cron → POST /api/interviews/reminders/process."
        );
    } else {
        console.log(`📌 API URL: http://localhost:${PORT}`);
    }

    warnIfEmailEnvMissing();
    ensureTransporterVerified().catch((err) => {
        console.error("[Email] Startup SMTP verify error:", err.message);
        if (err.stack) console.error(err.stack);
    });

    const { isHmsConfigured, publicWebhookUrl } = require("./src/services/hmsTokenService");
    if (!isHmsConfigured()) {
        console.warn(
            "[100MS] Credentials missing. Live rooms are disabled until HMS_APP_ACCESS_KEY, HMS_APP_SECRET, and HMS_TEMPLATE_ID are set."
        );
    } else {
        const webhookUrl = publicWebhookUrl();
        if (webhookUrl) {
            console.log(`[100MS] Webhook endpoint: ${webhookUrl}`);
        } else {
            console.warn(
                "[100MS] No public backend URL detected. Configure the 100ms dashboard webhook to POST /api/100ms/webhook on this service."
            );
        }
    }

    startReminderScheduler();
});

function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Closing server gracefully...`);
    if (rateLimitInterval) {
        clearInterval(rateLimitInterval);
    }
    if (typeof progressStore.stopCleanup === "function") {
        progressStore.stopCleanup();
    }
    stopReminderScheduler();
    server.close(() => {
        console.log("Server closed.");
        process.exit(0);
    });

    setTimeout(() => {
        console.error("Forcing shutdown after timeout.");
        process.exit(1);
    }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
    console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
    console.error("[uncaughtException]", err);
    gracefulShutdown("uncaughtException");
});