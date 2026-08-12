// =============================================================================
// Data Models for the Resume Evaluator UI
// =============================================================================
// These interfaces define the shape of data exchanged between the frontend
// and the backend API. They are consumed by app.ts and all child components.
// =============================================================================

export interface Analysis {
  candidateName: string;
  email: string;
  phone: string;
  currentCompany: string;
  currentDesignation: string;
  yearsOfExperience: string;
  skills: string[];
  experience: string;
  strengths: string[];
  weaknesses: string[];
  age: string;
  highestEducation: string;
  noticePeriod: string;
  location: string;
  numberOfCompaniesWorkedWith: string | number;
  certifications: string[];
  additional: string;
  role: string;
  interviewLevel: string;
}

export interface Evaluation {
  score: number | null;
  overallScore: number | null;
  scoreBreakdown: {
    experience: number;
    technicalSkills: number;
    projects: number;
    education: number;
    certifications: number;
    communication: number;
    resumeQuality: number;
    leadership: number;
  };
  skills: string[];
  strengths: string[];
  weaknesses: string[];
  result: string;
  recommendation?: string;
  reasoning: string;
  selected: boolean;
}

export interface AtsBreakdown {
  contactInformation: number;
  resumeStructure: number;
  skills: number;
  experience: number;
  education: number;
  keywordOptimization: number;
  formatting: number;
}

export interface AtsEvaluation {
  atsScore: number | null;
  atsGrade: string;
  atsSummary: string;
  atsBreakdown: AtsBreakdown;
  missingKeywords: string[];
  formatIssues: string[];
  recommendations: string[];
}

export interface InterviewTurn {
  speaker: string;
  text: string;
}

export interface InterviewTranscript {
  title: string;
  summary: string;
  transcriptTurns: InterviewTurn[];
}

export interface UploadResult {
  success: boolean;
  message?: string;
  uploadId?: string;
  /** Server-side resume UUID used for progress polling (may equal uploadId for single uploads). */
  resumeId?: string;
  analysis?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  atsEvaluation?: Record<string, unknown>;
  interviewTranscript?: InterviewTurn[] | string;
  emailSent?: boolean;
  emailSkipped?: boolean;
  emailError?: string | null;
  reportPath?: string;
  reportFilename?: string;
  transcriptPath?: string;
  transcriptFilename?: string;
  podcastPath?: string | null;
  podcastScriptPath?: string | null;
  podcastScript?: string | null;
  fileName?: string;
}

// =============================================================================
// Upload Progress (polling)
// =============================================================================

export interface UploadProgressResume {
  resumeId: string;
  filename: string;
  originalFilename: string;
  status: ResumeStatus;
  progress: number;
  elapsedSeconds: number | null;
  error: string | null;
  podcastPath?: string;
  podcastScriptPath?: string;
  emailSent?: boolean;
  emailSkipped?: boolean;
  emailError?: string | null;
}

export interface UploadProgress {
  uploadId: string;
  totalResumes: number;
  completed: number;
  failed: number;
  overallProgress: number;
  resumes: UploadProgressResume[];
}

/** Lifecycle status of a single resume within the processing queue. */
export type ResumeStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed';

/** Ordered processing stages shown while a resume is being analysed. */
export type ResumeStage =
  | 'Extracting PDF'
  | 'Analysing Resume'
  | 'Generating Interview'
  | 'Generating Podcast'
  | 'Evaluating Candidate'
  | 'Sending Email'
  | 'Completed';

export const RESUME_STAGES: ResumeStage[] = [
  'Extracting PDF',
  'Analysing Resume',
  'Generating Interview',
  'Generating Podcast',
  'Evaluating Candidate',
  'Sending Email',
  'Completed',
];

/** Normalized result for a single resume in the queue. */
export interface ResumeProcessedResult {
  raw: UploadResult;
  analysis: Analysis;
  evaluation: Evaluation;
  atsEvaluation: AtsEvaluation;
  parsedTranscript?: InterviewTranscript;
}

/** A single resume task tracked through the upload/processing queue. */
export interface ResumeTask {
  id: string;
  /** Original File blob; null after session restore (browser refresh). */
  file: File | null;
  fileName: string;
  fileSize: number;
  order: number;
  status: ResumeStatus;
  /** 0 - 100 progress percentage. */
  progress: number;
  /** Index into RESUME_STAGES, -1 when not yet started. */
  stageIndex: number;
  /** Elapsed processing time in seconds (only counts while processing). */
  elapsedSeconds: number;
  error: string | null;
  result: ResumeProcessedResult | null;
  /** Backend upload ID used for progress polling. */
  uploadId?: string;
  /** Backend resume UUID matched against progress.resumes[].resumeId. */
  resumeId?: string;
  /**
   * JD-primary structured interview question bank for this candidate.
   * Populated automatically after successful Analyse Resume when a JD is present.
   */
  structuredInterview?: StructuredInterview | null;
  /** Non-fatal interview-generation failure for this candidate (analysis still succeeded). */
  interviewGenError?: string | null;
}

// =============================================================================
// Job Description & Candidate Ranking
// =============================================================================

export interface JdAnalysis {
  jobTitle: string;
  mandatorySkills: string[];
  preferredSkills: string[];
  yearsOfExperience: string;
  education: string;
  certifications: string[];
  domain: string;
  roleDescription: string;
  projectRelevance?: string;
  technicalRequirements?: string[];
}

export interface RankedCandidate {
  rank: number;
  candidateName: string;
  matchScore: number;
  reason: string;
  strengths: string[];
  weaknesses: string[];
  recommendation: 'Shortlist' | 'Hold' | 'Reject' | string;
}

export interface CandidateRanking {
  rankings: RankedCandidate[];
}

export interface ParseJdResult {
  success: boolean;
  filename?: string;
  jdAnalysis?: JdAnalysis;
  message?: string;
}

export interface RankCandidatesResult {
  success: boolean;
  candidateRanking?: CandidateRanking;
  message?: string;
}

// =============================================================================
// Structured Interview Question Bank (JD-primary interview plan for AI Interview Bot)
// =============================================================================

export interface InterviewQuestion {
  questionNo: number;
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | string;
  estimatedTime: string;
  question: string;
  /** @deprecated Questions-only interview plan — answers are not generated. */
  expectedAnswer?: string;
}

export interface InterviewSection {
  sectionName: string;
  questions: InterviewQuestion[];
}

export interface StructuredInterview {
  interviewTitle: string;
  estimatedDuration: string;
  totalQuestions: number;
  sections: InterviewSection[];
}

export interface GenerateInterviewResult {
  success: boolean;
  interview?: StructuredInterview;
  analysis?: Analysis;
  jdAnalysis?: JdAnalysis;
  message?: string;
  error?: string;
  stage?: string;
}

// =============================================================================
// Interview Scheduling (Phase 2) + Interview Management
// =============================================================================

export type InterviewStatus =
  | 'Draft'
  | 'Scheduled'
  | 'Reminder Sent'
  | 'In Progress'
  | 'Completed'
  | 'Transcript Generated'
  | 'Evaluation Generated'
  | 'Result Generated'
  | 'Cancelled'
  | 'Expired';

/** Final hiring outcome — independent of lifecycle status. */
export type InterviewResult = 'Pending' | 'Selected' | 'Rejected';

/** Speakers allowed on the live podcast transcript (Voice AI session). */
export type PodcastTranscriptSpeaker = 'AI' | 'Candidate';

export type InterviewListFilter =
  | 'all'
  | 'upcoming'
  | 'today'
  | 'scheduled'
  | 'reminder sent'
  | 'in progress'
  | 'completed'
  | 'cancelled'
  | 'selected'
  | 'rejected'
  | 'pending'
  | 'pending evaluation'
  | 'expired';

export type InterviewSortBy =
  | 'date'
  | 'name'
  | 'result'
  | 'status'
  | 'score'
  | 'jdMatch'
  | 'technical';
export type InterviewSortDir = 'asc' | 'desc';

export type InterviewJoinState = 'ready' | 'started' | 'ended' | 'unavailable';

export interface InterviewJoinInfo {
  state: InterviewJoinState;
  label: string;
  message: string;
}

export interface InterviewReminderStatus {
  label: string;
  detail?: string;
  sent24h: boolean;
  sent1h: boolean;
  sent30m?: boolean;
  sent10m: boolean;
  sent: string[];
}

/** Reserved for Voice AI evaluation — null until live interview completes. */
export interface ScoreWithReason {
  score: number | null;
  reason?: string;
}

export type HiringRecommendation =
  | 'Strongly Recommended'
  | 'Recommended'
  | 'Recommended with Training'
  | 'Borderline'
  | 'Rejected'
  | string;

export interface InterviewEvaluation {
  /** Nested evidence-based scorecard (preferred). */
  technicalKnowledge?: ScoreWithReason | null;
  communication?: ScoreWithReason | null;
  problemSolving?: ScoreWithReason | number | null;
  confidence?: ScoreWithReason | null;
  behaviour?: ScoreWithReason | null;
  jdMatch?: ScoreWithReason | null;

  /** Flat aliases for legacy / dashboard consumers. */
  technicalScore?: number | null;
  communicationScore?: number | null;
  behaviourScore?: number | null;
  problemSolvingScore?: number | null;
  leadership?: number | null;
  jdMatchPercent?: number | null;
  confidencePercent?: number | null;
  overallScore?: number | null;

  recommendation?: HiringRecommendation | null;
  result?: InterviewResult | string | null;
  summary?: string | null;
  strengths?: string[];
  weaknesses?: string[];
  missingSkills?: string[];
  knowledgeGaps?: string[];
  redFlags?: string[];
  potential?: string[];
  hiringRisks?: string[];
  weights?: Record<string, number>;
  selectedThreshold?: number;
  source?: string | null;
  evaluatedAt?: string | null;
}

/** One line from the real AI ↔ Candidate conversation. */
export interface PodcastTranscriptLine {
  timestamp: string;
  speaker: PodcastTranscriptSpeaker | string;
  text: string;
}

/** Stored podcast transcript metadata + lines (post-completion only). */
export interface PodcastTranscript {
  transcriptId: string;
  interviewId: string;
  candidateId: string;
  lines: PodcastTranscriptLine[];
  createdAt: string;
  duration: number;
  wordCount: number;
  audioFilePath?: string | null;
  transcriptFilePath?: string | null;
  evaluationStatus?: string | null;
  provider?: string | null;
  lineCount?: number;
}

export interface TranscriptMeta {
  transcriptId?: string;
  createdAt?: string;
  duration?: number;
  wordCount?: number;
  evaluationStatus?: string;
  lineCount?: number;
  evaluationError?: string;
}

/** Immutable hiring-result history entry (never overwrites prior results). */
export interface InterviewResultHistoryEntry {
  interviewId: string;
  evaluationId: string;
  result: InterviewResult | string;
  overallScore?: number | null;
  jdMatchPercent?: number | null;
  recommendation?: string | null;
  generatedAt: string;
  generatedDate?: string;
  generatedTime?: string;
}

/** Dashboard summary counters for Interview Management. */
export interface InterviewStats {
  total: number;
  scheduled: number;
  completed: number;
  selected: number;
  rejected: number;
  pending: number;
  pendingEvaluation: number;
  cancelled?: number;
  inProgress?: number;
  reminderSent?: number;
  averageJdMatch?: number | null;
  averageTechnicalScore?: number | null;
  averageCommunicationScore?: number | null;
  averageInterviewDurationMinutes?: number | null;
}

/** Downloadable artifact pointers for a completed + evaluated interview. */
export interface InterviewDownloadableFiles {
  interviewId: string;
  transcriptFile?: string | null;
  recordingFile?: string | null;
  evaluationPdf?: string | null;
  excelSummary?: string | null;
  creationDate?: string | null;
  createdBy?: string | null;
  generatedTimestamp?: string | null;
}

/** Ranked candidate row from completed AI evaluations. */
export interface InterviewRankedCandidate {
  rank: number;
  interviewId: string;
  candidateId?: string;
  candidateName: string;
  jobRole?: string | null;
  currentCompany?: string | null;
  interviewDate?: string | null;
  technical?: number | null;
  communication?: number | null;
  problemSolving?: number | null;
  behaviour?: number | null;
  confidence?: number | null;
  jdMatch?: number | null;
  overallScore?: number | null;
  rankingScore?: number | null;
  recommendation?: string | null;
  result?: InterviewResult | string;
  strengths?: string[];
  weaknesses?: string[];
  resumeSummary?: Analysis | Record<string, unknown> | null;
}

export interface InterviewRankingResult {
  success: boolean;
  count?: number;
  rankings?: InterviewRankedCandidate[];
  message?: string;
  error?: string;
}

/** Side-by-side compare row. */
export interface InterviewCompareCandidate {
  interviewId: string;
  candidateName: string;
  jobRole?: string | null;
  currentCompany?: string | null;
  resume?: Analysis | Record<string, unknown> | null;
  jdMatch?: number | null;
  technical?: number | null;
  communication?: number | null;
  problemSolving?: number | null;
  behaviour?: number | null;
  confidence?: number | null;
  overallScore?: number | null;
  strengths?: string[];
  weaknesses?: string[];
  recommendation?: string | null;
  result?: InterviewResult | string;
  interviewDate?: string | null;
  status?: string;
}

export interface InterviewCompareResult {
  success: boolean;
  count?: number;
  candidates?: InterviewCompareCandidate[];
  message?: string;
  error?: string;
}

export interface InterviewStatsResult {
  success: boolean;
  stats?: InterviewStats;
  message?: string;
  error?: string;
}

export interface ScheduledInterview {
  id: string;
  candidateId: string;
  resumeId: string | null;
  jdId: string | null;
  candidateName: string;
  candidateEmail: string;
  jobRole?: string | null;
  currentCompany?: string | null;
  interviewer?: string | null;
  resumeSummary: Analysis | Record<string, unknown> | null;
  jobDescription: JdAnalysis | Record<string, unknown> | null;
  interviewJson: StructuredInterview | Record<string, unknown> | null;
  date: string | null;
  time: string | null;
  timezone: string;
  durationMinutes: number;
  scheduledAt: string | null;
  meetingLink: string;
  status: InterviewStatus | string;
  result?: InterviewResult | string;
  transcriptId?: string | null;
  transcriptPath?: string | null;
  recordingPath?: string | null;
  evaluationPath?: string | null;
  evaluation?: InterviewEvaluation | null;
  evaluationId?: string | null;
  resultGeneratedAt?: string | null;
  resultHistory?: InterviewResultHistoryEntry[];
  transcriptMeta?: TranscriptMeta | null;
  excelSummaryPath?: string | null;
  excelSummaryFilename?: string | null;
  excelSummaryUrl?: string | null;
  downloadableFiles?: InterviewDownloadableFiles | null;
  joinState?: InterviewJoinInfo;
  artifactsAvailable?: boolean;
  isCompleted?: boolean;
  reminders?: {
    sent24h?: boolean;
    sent1h?: boolean;
    sent30m?: boolean;
    sent10m?: boolean;
  };
  reminderTimestamps?: Record<string, string | null>;
  reminderTimestamp?: string | null;
  reminderSent?: boolean;
  interviewDate?: string | null;
  interviewTime?: string | null;
  scheduledTimestamp?: string | null;
  reminderStatus?: InterviewReminderStatus;
  invitationSent?: boolean;
  invitationSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PodcastTranscriptResult {
  success: boolean;
  available?: boolean;
  message?: string;
  interviewId?: string;
  candidateId?: string;
  status?: string;
  transcript?: PodcastTranscript | null;
  totalLines?: number;
  matchedLines?: number;
  error?: string;
}

export interface CompleteInterviewPayload {
  lines: PodcastTranscriptLine[];
  audioFilePath?: string | null;
  durationSeconds?: number | null;
  provider?: string | null;
  skipEvaluation?: boolean;
}

export interface CompleteInterviewResult {
  success: boolean;
  message?: string;
  interview?: ScheduledInterview;
  transcript?: PodcastTranscript | null;
  evaluation?: InterviewEvaluation | null;
  result?: InterviewResult | string;
  error?: string;
}

export interface CreateInterviewPayload {
  candidateName: string;
  candidateEmail: string;
  date: string;
  time: string;
  timezone: string;
  duration?: number;
  durationMinutes?: number;
  status?: InterviewStatus | string;
  saveAsDraft?: boolean;
  resumeId?: string | null;
  jdId?: string | null;
  candidateId?: string;
  meetingLink?: string;
  jobRole?: string | null;
  currentCompany?: string | null;
  interviewer?: string | null;
  interview?: StructuredInterview | null;
  interviewJson?: StructuredInterview | null;
  analysis?: Analysis | null;
  resumeSummary?: Analysis | null;
  jdAnalysis?: JdAnalysis | null;
  jobDescription?: JdAnalysis | null;
  result?: InterviewResult | string;
  transcriptPath?: string | null;
  recordingPath?: string | null;
  evaluationPath?: string | null;
  evaluation?: InterviewEvaluation | null;
}

export interface InterviewListResult {
  success: boolean;
  count?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  interviews?: ScheduledInterview[];
  message?: string;
  error?: string;
}

export interface InterviewDetailResult {
  success: boolean;
  interview?: ScheduledInterview;
  email?: { success?: boolean; skipped?: boolean; error?: string; messageId?: string } | null;
  message?: string;
  error?: string;
}

export const COMMON_TIMEZONES: string[] = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
];
