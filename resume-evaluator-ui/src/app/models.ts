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
  yearsOfExperience: string;
  skills: string[];
  experience: string;
  strengths: string[];
  weaknesses: string[];
}

export interface Evaluation {
  score: number | null;
  skills: string[];
  strengths: string[];
  weaknesses: string[];
  result: string;
  recommendation?: string;
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
  analysis?: Record<string, unknown>;
  evaluation?: Record<string, unknown>;
  interviewTranscript?: string;
  emailSent?: boolean;
  reportPath?: string;
  reportFilename?: string;
  transcriptPath?: string;
  transcriptFilename?: string;
  podcastPath?: string;
  fileName?: string;
}

// =============================================================================
// Multi-Resume Analysis Queue Models
// =============================================================================

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
}