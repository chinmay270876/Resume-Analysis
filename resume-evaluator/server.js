require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;

// ================================
// Trust Proxy (for correct client IP behind reverse proxy)
// ================================

app.set("trust proxy", 1);

// ================================
// Environment Validation
// ================================

if (!process.env.HF_TOKEN && !process.env.OPENAI_API_KEY) {

    console.error(
        "\x1b[31m%s\x1b[0m",
        "CRITICAL ERROR: HF_TOKEN or OPENAI_API_KEY missing"
    );

    process.exit(1);

}

// ================================
// CORS
// ================================

const defaultOrigins = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
];

const allowedOrigins = process.env.CORS_ORIGINS ?
    process.env.CORS_ORIGINS.split(",") :
    defaultOrigins;

app.use(cors({
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
}));

// ================================
// Security Headers
// ================================

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    next();
});

// ================================
// Static File Serving (output, results)
// ================================

const outputDirName = process.env.OUTPUT_DIR || "output";
const reportDirName = process.env.REPORT_DIR || "results";

app.use(`/${outputDirName}`, express.static(path.join(process.cwd(), outputDirName)));
app.use(`/${reportDirName}`, express.static(path.join(process.cwd(), reportDirName)));

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
    limit: "10mb"
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

// ================================
// Routes
// ================================

const resumeRoutes =
    require("./src/routes/resumeRoutes");

app.use("/api", resumeRoutes);

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

    const isProduction = process.env.NODE_ENV === "production";

    res.status(err.status || 500).json({
        success: false,
        error: isProduction ? "Something went wrong" : err.message,
    });
});

// ================================
// Graceful Shutdown
// ================================

const server = app.listen(PORT, () => {
    console.log(`🚀 Server Running on port ${PORT}`);
    console.log(`📌 API URL: http://localhost:${PORT}`);
});

function gracefulShutdown(signal) {
    console.log(`\n${signal} received. Closing server gracefully...`);
    if (rateLimitInterval) {
        clearInterval(rateLimitInterval);
    }
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