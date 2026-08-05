const express = require("express");
const router = express.Router();

const {
    createInterview,
    listInterviews,
    getInterview,
    updateInterview,
    deleteInterview,
} = require("../controllers/interviewController");

router.post("/", createInterview);
router.get("/", listInterviews);
router.get("/:id", getInterview);
router.patch("/:id", updateInterview);
router.delete("/:id", deleteInterview);

module.exports = router;
