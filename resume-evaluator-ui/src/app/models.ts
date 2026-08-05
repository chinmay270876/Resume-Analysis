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
  file: File;
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
// Structured Interview Question Bank (Resume + JD)
// =============================================================================

export interface InterviewQuestion {
  questionNo: number;
  category: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | string;
  estimatedTime: string;
  question: string;
  expectedAnswer: string;
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
// Interview Scheduling (Phase 2)
// =============================================================================

export type InterviewStatus =
  | 'Draft'
  | 'Scheduled'
  | 'Reminder Sent'
  | 'In Progress'
  | 'Completed'
  | 'Cancelled'
  | 'Expired';

export type InterviewListFilter = 'upcoming' | 'today' | 'completed' | 'cancelled';

export interface InterviewReminderStatus {
  label: string;
  sent24h: boolean;
  sent1h: boolean;
  sent10m: boolean;
  sent: string[];
}

export interface ScheduledInterview {
  id: string;
  candidateId: string;
  resumeId: string | null;
  jdId: string | null;
  candidateName: string;
  candidateEmail: string;
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
  reminders?: {
    sent24h?: boolean;
    sent1h?: boolean;
    sent10m?: boolean;
  };
  reminderStatus?: InterviewReminderStatus;
  invitationSent?: boolean;
  invitationSentAt?: string | null;
  createdAt: string;
  updatedAt: string;
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
  interview?: StructuredInterview | null;
  interviewJson?: StructuredInterview | null;
  analysis?: Analysis | null;
  resumeSummary?: Analysis | null;
  jdAnalysis?: JdAnalysis | null;
  jobDescription?: JdAnalysis | null;
}

export interface InterviewListResult {
  success: boolean;
  count?: number;
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
