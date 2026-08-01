const { getAiResponse } = require("./openaiService");
const fs = require("fs").promises;
const path = require("path");

const templateCache = new Map();
const VALID_RECOMMENDATIONS = new Set(["Shortlist", "Hold", "Reject"]);

async function getRankingPrompt() {
    if (templateCache.has("ranking-prompt")) {
        return templateCache.get("ranking-prompt");
    }
    const promptTemplate = await fs.readFile(
        path.join(process.cwd(), "templates", "ranking-prompt.txt"),
        "utf-8"
    );
    templateCache.set("ranking-prompt", promptTemplate);
    return promptTemplate;
}

function buildCandidateSummary(candidate) {
    const { analysis, evaluation } = candidate;
    return {
        candidateName: analysis?.candidateName || candidate.candidateName || "Unknown",
        yearsOfExperience: analysis?.yearsOfExperience || "",
        highestEducation: analysis?.highestEducation || "",
        skills: analysis?.skills || [],
        certifications: analysis?.certifications || [],
        experience: analysis?.experience || "",
        currentCompany: analysis?.currentCompany || "",
        currentDesignation: analysis?.currentDesignation || "",
        role: analysis?.role || "",
        evaluationScore: evaluation?.score ?? evaluation?.overallScore ?? null,
        scoreBreakdown: evaluation?.scoreBreakdown || {},
        evaluationStrengths: evaluation?.strengths || [],
        evaluationWeaknesses: evaluation?.weaknesses || [],
    };
}

function normalizeRecommendation(value) {
    const raw = String(value || "").trim();
    if (VALID_RECOMMENDATIONS.has(raw)) {
        return raw;
    }
    const lower = raw.toLowerCase();
    if (lower.includes("shortlist") || lower.includes("select") || lower.includes("hire")) {
        return "Shortlist";
    }
    if (lower.includes("hold") || lower.includes("maybe") || lower.includes("consider")) {
        return "Hold";
    }
    return "Reject";
}

function normalizeRankings(rawRankings, candidates) {
    const candidateNames = candidates.map(
        (c) => c.analysis?.candidateName || c.candidateName || "Unknown"
    );

    const byName = new Map();
    for (const entry of rawRankings) {
        const name = String(entry.candidateName || "").trim();
        if (!name) continue;

        const matchScore = Math.max(0, Math.min(100, Math.round(Number(entry.matchScore) || 0)));
        const rank = Number(entry.rank) || 0;
        const strengths = Array.isArray(entry.strengths) ? entry.strengths.map(String).filter(Boolean) : [];
        const weaknesses = Array.isArray(entry.weaknesses) ? entry.weaknesses.map(String).filter(Boolean) : [];

        byName.set(name.toLowerCase(), {
            candidateName: name,
            matchScore,
            rank,
            reason: String(entry.reason || "").trim(),
            strengths,
            weaknesses,
            recommendation: normalizeRecommendation(entry.recommendation),
        });
    }

    const normalized = candidateNames.map((name) => {
        const existing = byName.get(name.toLowerCase());
        if (existing) {
            return existing;
        }
        return {
            candidateName: name,
            matchScore: 0,
            rank: 0,
            reason: "Ranking data unavailable for this candidate.",
            strengths: [],
            weaknesses: ["Insufficient data for JD comparison."],
            recommendation: "Hold",
        };
    });

    normalized.sort((a, b) => b.matchScore - a.matchScore);
    normalized.forEach((entry, index) => {
        entry.rank = index + 1;
        if (entry.rank <= 2) {
            if (entry.strengths.length === 0 && entry.weaknesses.length > 0) {
                entry.strengths = [...entry.weaknesses];
                entry.weaknesses = [];
            }
        } else if (entry.weaknesses.length === 0 && entry.strengths.length > 0) {
            entry.weaknesses = [...entry.strengths];
            entry.strengths = [];
        }
    });

    return normalized;
}

async function rankCandidatesAgainstJd(jdAnalysis, candidates) {
    if (!jdAnalysis || typeof jdAnalysis !== "object") {
        const err = new Error("Job description analysis is required for candidate ranking.");
        err.status = 400;
        throw err;
    }

    if (!Array.isArray(candidates) || candidates.length < 2) {
        const err = new Error("At least 2 successfully processed candidates are required for ranking.");
        err.status = 400;
        throw err;
    }

    const promptTemplate = await getRankingPrompt();
    const candidatesData = candidates.map(buildCandidateSummary);

    const prompt = promptTemplate
        .replace("{{jdAnalysis}}", JSON.stringify(jdAnalysis, null, 2))
        .replace("{{candidatesData}}", JSON.stringify(candidatesData, null, 2));

    const model = process.env.OPENAI_EVALUATION_MODEL || process.env.MODEL_NAME || "gpt-4o-mini";

    const rankingSchema = {
        type: "json_schema",
        json_schema: {
            name: "candidate_ranking",
            strict: true,
            schema: {
                type: "object",
                properties: {
                    rankings: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                rank: { type: "number", description: "Rank position (1 = best match)" },
                                candidateName: { type: "string" },
                                matchScore: { type: "number", description: "Match score 0-100 against the JD" },
                                reason: { type: "string", description: "Brief explanation of ranking vs JD" },
                                strengths: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "3-6 strengths for Rank 1-2 only; empty for others",
                                },
                                weaknesses: {
                                    type: "array",
                                    items: { type: "string" },
                                    description: "3-6 weaknesses for Rank 3+ only; empty for Rank 1-2",
                                },
                                recommendation: {
                                    type: "string",
                                    description: "Shortlist, Hold, or Reject",
                                },
                            },
                            required: ["rank", "candidateName", "matchScore", "reason", "strengths", "weaknesses", "recommendation"],
                            additionalProperties: false,
                        },
                    },
                },
                required: ["rankings"],
                additionalProperties: false,
            },
        },
    };

    console.log("-------------------------------------------------");
    console.log(`🏆 Starting Candidate Ranking with ${model}`);
    console.log(`   Candidates: ${candidates.length}`);
    console.log("-------------------------------------------------");

    const result = await getAiResponse(
        "You are an AI comparative ranking engine. Rank all candidates against the job description using pre-extracted data only.",
        prompt,
        model,
        0.2,
        rankingSchema
    );

    const rawRankings = Array.isArray(result?.rankings) ? result.rankings : [];
    const rankings = normalizeRankings(rawRankings, candidates);

    return { rankings };
}

module.exports = {
    rankCandidatesAgainstJd,
};
