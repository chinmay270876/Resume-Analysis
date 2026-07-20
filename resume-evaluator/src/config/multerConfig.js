const multer = require("multer");
const path = require("path");
const fsp = require("fs").promises;

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadDir = process.env.UPLOAD_DIR || "uploads/";
        try {
            await fsp.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },

    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const uniqueName = Date.now() + "-" + Math.random().toString(36).substring(2, 9) + ext;
        cb(null, uniqueName);
    },
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = [".pdf", ".docx"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(ext)) {
        cb(null, true);
    } else {
        const err = new Error("Only PDF and DOCX allowed");
        err.status = 400;
        cb(err);
    }
};

const createMulter = (maxCount) => {
    return multer({
        storage,
        fileFilter,
        limits: {
            fileSize: 5 * 1024 * 1024, // 5MB limit
            files: maxCount
        },
    });
};

module.exports = {
    single: (fieldName) => createMulter(1).single(fieldName),
    array: (fieldName, maxCount) => createMulter(maxCount).array(fieldName, maxCount),
};
