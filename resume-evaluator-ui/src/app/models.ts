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
  /** Backend upload/resume ID used for status polling. */
  uploadId?: string;
}