import { Injectable, PLATFORM_ID, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subscription, throwError, interval } from 'rxjs';
import { catchError, map, switchMap, take, filter } from 'rxjs/operators';
import { ResumeService } from './resume';
import { ToastService } from './toast';
import {
  Analysis,
  AtsEvaluation,
  CandidateRanking,
  Evaluation,
  InterviewTranscript,
  InterviewTurn,
  JdAnalysis,
  RESUME_STAGES,
  ResumeProcessedResult,
  ResumeTask,
  StructuredInterview,
  UploadProgress,
  UploadProgressResume,
  UploadResult,
} from '../models';
import { resolveApiBase, withApiKeyQuery } from '../utils/api-base';

const MAX_FILES = 5;
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const API_BASE = resolveApiBase();
/** sessionStorage key for Resume Analysis UI session (survives route recreation / soft refresh). */
const SESSION_STORAGE_KEY = 'resume-analysis-session';
const SESSION_VERSION = 1;

interface JdFileMeta {
  name: string;
  size: number;
}

interface PersistedSession {
  version: number;
  tasks: Array<Omit<ResumeTask, 'file'> & { file: null }>;
  orderSeq: number;
  overall: {
    total: number;
    completed: number;
    failed: number;
    elapsedSeconds: number;
  };
  jdFileMeta: JdFileMeta | null;
  jdAnalysis: JdAnalysis | null;
  candidateRanking: CandidateRanking | null;
  rankingError: string | null;
  showQueue: boolean;
  structuredInterview: StructuredInterview | null;
  interviewAnalysis: Analysis | null;
  interviewJdAnalysis: JdAnalysis | null;
  interviewError: string | null;
}

function normalizeAnalysis(raw: Record<string, unknown> | undefined): Analysis | null {
  if (!raw) {
    return null;
  }
  return {
    candidateName: String(raw['candidateName'] ?? raw['name'] ?? raw['candidate_name'] ?? ''),
    email: String(raw['email'] ?? ''),
    phone: String(raw['phone'] ?? ''),
    currentCompany: String(raw['currentCompany'] ?? raw['company'] ?? raw['current_company'] ?? raw['role'] ?? ''),
    currentDesignation: String(raw['currentDesignation'] ?? raw['designation'] ?? raw['current_designation'] ?? raw['roleTitle'] ?? ''),
    yearsOfExperience: String(raw['yearsOfExperience'] ?? raw['yoe'] ?? raw['years_of_experience'] ?? ''),
    skills: Array.isArray(raw['skills']) ? raw['skills'].map(String) : [],
    experience: String(raw['experience'] ?? ''),
    strengths: Array.isArray(raw['strengths']) ? raw['strengths'].map(String) : [],
    weaknesses: Array.isArray(raw['weaknesses']) ? raw['weaknesses'].map(String) : [],
    age: String(raw['age'] ?? ''),
    highestEducation: String(raw['highestEducation'] ?? raw['education'] ?? raw['qualification'] ?? ''),
    noticePeriod: String(raw['noticePeriod'] ?? ''),
    location: String(raw['location'] ?? ''),
    numberOfCompaniesWorkedWith: String(raw['numberOfCompaniesWorkedWith'] ?? ''),
    certifications: Array.isArray(raw['certifications']) ? raw['certifications'].map(String) : [],
    additional: String(raw['additional'] ?? ''),
    role: String(raw['role'] ?? raw['roleTitle'] ?? ''),
    interviewLevel: String(raw['interviewLevel'] ?? ''),
  };
}

function normalizeEvaluation(raw: Record<string, unknown> | undefined): Evaluation | null {
  if (!raw) {
    return null;
  }

  const scoreValue = raw['score'] ?? raw['overallScore'];
  let score: number | null = null;
  if (scoreValue !== undefined && scoreValue !== null && String(scoreValue).trim() !== '') {
    const parsed = Number(scoreValue);
    score = Number.isNaN(parsed) ? null : parsed;
  }

  const rawBreakdown = raw['scoreBreakdown'] as Record<string, unknown> | undefined;
  const scoreBreakdown: Evaluation['scoreBreakdown'] = {
    experience: typeof rawBreakdown?.['experience'] === 'number' ? rawBreakdown['experience'] : 0,
    technicalSkills: typeof rawBreakdown?.['technicalSkills'] === 'number' ? rawBreakdown['technicalSkills'] : 0,
    projects: typeof rawBreakdown?.['projects'] === 'number' ? rawBreakdown['projects'] : 0,
    education: typeof rawBreakdown?.['education'] === 'number' ? rawBreakdown['education'] : 0,
    certifications: typeof rawBreakdown?.['certifications'] === 'number' ? rawBreakdown['certifications'] : 0,
    communication: typeof rawBreakdown?.['communication'] === 'number' ? rawBreakdown['communication'] : 0,
    resumeQuality: typeof rawBreakdown?.['resumeQuality'] === 'number' ? rawBreakdown['resumeQuality'] : 0,
    leadership: typeof rawBreakdown?.['leadership'] === 'number' ? rawBreakdown['leadership'] : 0,
  };

  return {
    score,
    overallScore: score,
    scoreBreakdown,
    skills: Array.isArray(raw['skills']) ? raw['skills'].map(String) : [],
    strengths: Array.isArray(raw['strengths']) ? raw['strengths'].map(String) : [],
    weaknesses: Array.isArray(raw['weaknesses']) ? raw['weaknesses'].map(String) : [],
    result: String(raw['result'] ?? raw['recommendation'] ?? ''),
    recommendation: raw['recommendation'] ? String(raw['recommendation']) : undefined,
    reasoning: String(raw['reasoning'] ?? ''),
    selected: Boolean(raw['selected']),
  };
}

function normalizeAts(raw: Record<string, unknown> | undefined): AtsEvaluation {
  if (!raw) {
    return {
      atsScore: null,
      atsGrade: "",
      atsSummary: "ATS evaluation unavailable",
      atsBreakdown: {
        contactInformation: 0,
        resumeStructure: 0,
        skills: 0,
        experience: 0,
        education: 0,
        keywordOptimization: 0,
        formatting: 0,
      },
      missingKeywords: [],
      formatIssues: [],
      recommendations: [],
    };
  }

  const rawScore = raw['atsScore'];
  let atsScore: number | null = null;
  if (rawScore !== undefined && rawScore !== null && String(rawScore).trim() !== '') {
    const parsed = Number(rawScore);
    atsScore = Number.isNaN(parsed) ? null : parsed;
  }

  const parseNum = (val: unknown): number => {
    if (typeof val === 'number') return Number.isNaN(val) ? 0 : val;
    if (typeof val === 'string') {
      const parsed = parseFloat(val);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };

  const rawBreakdown = raw['atsBreakdown'] as Record<string, unknown> | undefined;
  const atsBreakdown: AtsEvaluation['atsBreakdown'] = {
    contactInformation: parseNum(rawBreakdown?.['contactInformation']),
    resumeStructure: parseNum(rawBreakdown?.['resumeStructure']),
    skills: parseNum(rawBreakdown?.['skills']),
    experience: parseNum(rawBreakdown?.['experience']),
    education: parseNum(rawBreakdown?.['education']),
    keywordOptimization: parseNum(rawBreakdown?.['keywordOptimization']),
    formatting: parseNum(rawBreakdown?.['formatting']),
  };

  const summary = raw['atsSummary'] ? String(raw['atsSummary']) : (atsScore !== null ? "" : "ATS evaluation unavailable");

  return {
    atsScore,
    atsGrade: raw['atsGrade'] ? String(raw['atsGrade']) : "",
    atsSummary: summary,
    atsBreakdown,
    missingKeywords: Array.isArray(raw['missingKeywords']) ? raw['missingKeywords'].map(String) : [],
    formatIssues: Array.isArray(raw['formatIssues']) ? raw['formatIssues'].map(String) : [],
    recommendations: Array.isArray(raw['recommendations']) ? raw['recommendations'].map(String) : [],
  };
}

function parseTranscript(interviewTranscript: unknown): InterviewTranscript | undefined {
  if (!interviewTranscript) {
    return undefined;
  }
  try {
    const data: Record<string, unknown> =
      typeof interviewTranscript === 'string'
        ? JSON.parse(interviewTranscript)
        : (interviewTranscript as Record<string, unknown>);

    const rawTurns = Array.isArray(data)
        ? data
        : data?.['transcriptTurns'];
    const transcriptTurns: InterviewTurn[] = Array.isArray(rawTurns)
      ? rawTurns.map((turn: Record<string, unknown>) => ({
          speaker: String(turn['speaker'] ?? turn['role'] ?? 'Unknown'),
          text: String(turn['text'] ?? turn['content'] ?? turn['message'] ?? ''),
        }))
      : [];

    return {
      title: String(data?.['title'] ?? 'Interview Transcript'),
      summary: String(data?.['summary'] ?? ''),
      transcriptTurns,
    };
  } catch {
    return {
      title: 'Interview Transcript',
      summary: String(interviewTranscript),
      transcriptTurns: [],
    };
  }
}

/**
 * Orchestrates the multi-resume analysis flow:
 * - collects 1-5 PDFs
 * - processes them sequentially (one at a time)
 * - drives per-resume progress, stages, elapsed timers and overall batch stats
 *
 * Uses a single shared 1s interval for all timers to avoid excessive polling
 * and duplicated change detection.
 */
@Injectable({ providedIn: 'root' })
export class ResumeQueueService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly resumeService = inject(ResumeService);
  private readonly toastService = inject(ToastService);

  readonly maxFiles = MAX_FILES;

  private taskList: ResumeTask[] = [];
  private orderSeq = 0;
  private processing = false;
  private timerSubscription: Subscription | null = null;
  private currentSubscription: Subscription | null = null;
  private pollingSubscriptions = new Map<string, Subscription>();
  /** Suppresses session writes while hydrating from sessionStorage. */
  private hydrating = false;

  // --- Public signals (updated immutably to drive Angular change detection) ---

  /** Ordered list of selected resumes (queued + processed). */
  readonly tasks = signal<ResumeTask[]>([]);
  /** True while any resume is being processed. */
  readonly isProcessing = signal<boolean>(false);
  /** Overall batch stats. */
  readonly overall = signal<{
    total: number;
    completed: number;
    failed: number;
    elapsedSeconds: number;
  }>({ total: 0, completed: 0, failed: 0, elapsedSeconds: 0 });
  /** True while a batch report download is in progress. */
  readonly batchDownloading = signal<boolean>(false);
  /** Tracks which resume report is currently being downloaded (null = idle). */
  readonly downloadingReportId = signal<string | null>(null);
  /** Optional uploaded job description file (not yet parsed). */
  readonly jdFile = signal<File | null>(null);
  /** JD filename/size for UI when the File blob is unavailable after refresh. */
  readonly jdFileMeta = signal<JdFileMeta | null>(null);
  /** Parsed job description analysis returned by the backend. */
  readonly jdAnalysis = signal<JdAnalysis | null>(null);
  /** Comparative ranking results (populated after all resumes finish). */
  readonly candidateRanking = signal<CandidateRanking | null>(null);
  /** True while JD is being parsed or candidates are being ranked. */
  readonly rankingInProgress = signal<boolean>(false);
  readonly rankingError = signal<string | null>(null);
  /** Whether the results / queue section should be visible. */
  readonly showQueue = signal(false);

  /** Structured interview generation (kept here so route navigation does not wipe it). */
  readonly interviewGenerating = signal(false);
  readonly interviewError = signal<string | null>(null);
  readonly structuredInterview = signal<StructuredInterview | null>(null);
  readonly interviewAnalysis = signal<Analysis | null>(null);
  readonly interviewJdAnalysis = signal<JdAnalysis | null>(null);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.restoreFromSession();
      // Persist whenever durable session signals change (navigation-safe + soft refresh).
      effect(() => {
        this.tasks();
        this.overall();
        this.jdFileMeta();
        this.jdAnalysis();
        this.candidateRanking();
        this.rankingError();
        this.showQueue();
        this.structuredInterview();
        this.interviewAnalysis();
        this.interviewJdAnalysis();
        this.interviewError();
        if (!this.hydrating) {
          this.persistToSession();
        }
      });
    }
  }

  /** Returns the validation error message for a set of files, or null if valid. */
  validateFiles(files: FileList | File[]): string | null {
    const list = Array.from(files);
    if (!list.length) {
      return null;
    }
    const remaining = MAX_FILES - this.taskList.length;
    if (remaining <= 0) {
      return `You can upload a maximum of ${MAX_FILES} resumes.`;
    }
    if (list.length > remaining) {
      return `Only ${remaining} more resume${remaining === 1 ? '' : 's'} can be added.`;
    }
    for (const file of list) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.name.toLowerCase().endsWith('.docx');
      if (!isPdf && !isDocx) {
        return `"${file.name}" is not a PDF or DOCX file.`;
      }
      if (file.size > MAX_SIZE_BYTES) {
        return `"${file.name}" exceeds the 5MB limit.`;
      }
    }
    return null;
  }

  /** Adds valid PDF/DOCX files to the selection queue (does not start processing). */
  addFiles(files: FileList | File[]): string | null {
    const error = this.validateFiles(files);
    if (error) {
      return error;
    }
    const list = Array.from(files);
    for (const file of list) {
      const task: ResumeTask = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        fileName: file.name,
        fileSize: file.size,
        order: ++this.orderSeq,
        status: 'queued',
        progress: 0,
        stageIndex: -1,
        elapsedSeconds: 0,
        error: null,
        result: null,
      };
      this.taskList = [...this.taskList, task];
    }
    this.showQueue.set(true);
    this.emitTasks();
    return null;
  }

  /** Sets or clears the optional job description file. */
  setJobDescription(file: File | null): string | null {
    if (!file) {
      this.jdFile.set(null);
      this.jdFileMeta.set(null);
      this.jdAnalysis.set(null);
      this.candidateRanking.set(null);
      this.rankingError.set(null);
      this.clearInterviewResults();
      return null;
    }

    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isDocx =
      file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      file.name.toLowerCase().endsWith('.docx');
    if (!isPdf && !isDocx) {
      return `"${file.name}" is not a PDF or DOCX file.`;
    }
    if (file.size > MAX_SIZE_BYTES) {
      return `"${file.name}" exceeds the 5MB limit.`;
    }

    this.jdFile.set(file);
    this.jdFileMeta.set({ name: file.name, size: file.size });
    this.jdAnalysis.set(null);
    this.candidateRanking.set(null);
    this.rankingError.set(null);
    this.clearInterviewResults();
    return null;
  }

  removeJobDescription(): void {
    this.setJobDescription(null);
  }

  /** Removes a selected (not yet completed/processing) resume. */
  removeTask(id: string): void {
    const target = this.taskList.find((t) => t.id === id);
    if (!target || target.status === 'processing') {
      return;
    }
    this.taskList = this.taskList.filter((t) => t.id !== id);
    this.renumber();
    this.emitTasks();
    this.emitOverall();
    if (this.taskList.length === 0 && !this.structuredInterview() && !this.candidateRanking()) {
      this.showQueue.set(false);
    }
  }

  /**
   * Clears all Resume Analysis session state (queue, ranking, interview, sessionStorage).
   * Only call on explicit user action (Clear Results) — never on route enter.
   */
  reset(): void {
    this.currentSubscription?.unsubscribe();
    this.currentSubscription = null;
    this.stopTimer();
    this.pollingSubscriptions.forEach((sub) => sub.unsubscribe());
    this.pollingSubscriptions.clear();
    this.taskList = [];
    this.orderSeq = 0;
    this.processing = false;
    this.jdFile.set(null);
    this.jdFileMeta.set(null);
    this.jdAnalysis.set(null);
    this.candidateRanking.set(null);
    this.rankingInProgress.set(false);
    this.rankingError.set(null);
    this.showQueue.set(false);
    this.interviewGenerating.set(false);
    this.clearInterviewResults();
    this.emitTasks();
    this.isProcessing.set(false);
    this.emitOverall();
    this.clearSessionStorage();
  }

  /** Alias used by the Upload page Clear Results action. */
  clearResults(): void {
    if (this.processing || this.interviewGenerating()) {
      return;
    }
    this.reset();
  }

  /** Starts sequential processing of all queued resumes (and optional JD parsing). */
  start(): void {
    if (this.processing) {
      return;
    }
    this.currentSubscription?.unsubscribe();
    const hasQueued = this.taskList.some((t) => t.status === 'queued');
    if (!hasQueued) {
      return;
    }

    const jdFile = this.jdFile();
    if (jdFile) {
      const completedCount = this.taskList.filter((t) => t.status === 'completed').length;
      const queuedCount = this.taskList.filter((t) => t.status === 'queued').length;
      if (queuedCount + completedCount < 2) {
        this.rankingError.set('Upload at least 2 resumes when using a Job Description for ranking.');
        return;
      }

      this.processing = true;
      this.isProcessing.set(true);
      this.rankingInProgress.set(true);
      this.rankingError.set(null);
      this.candidateRanking.set(null);

      this.resumeService.parseJobDescription(jdFile).subscribe({
        next: (response) => {
          if (!response.success || !response.jdAnalysis) {
            this.rankingInProgress.set(false);
            this.processing = false;
            this.isProcessing.set(false);
            this.rankingError.set(response.message ?? 'Job description parsing failed.');
            return;
          }
          this.jdAnalysis.set(response.jdAnalysis);
          this.rankingInProgress.set(false);
          this.startTimer();
          this.processNext();
        },
        error: (err) => {
          this.rankingInProgress.set(false);
          this.processing = false;
          this.isProcessing.set(false);
          const message =
            (err as { error?: { error?: string; message?: string } })?.error?.error ??
            (err as { error?: { message?: string } })?.error?.message ??
            'Job description parsing failed.';
          this.rankingError.set(message);
        },
      });
      return;
    }

    this.processing = true;
    this.isProcessing.set(true);
    this.rankingError.set(null);
    this.candidateRanking.set(null);
    this.startTimer();
    this.processNext();
  }

  /** Clears tasks only after they have all finished (completed/failed). */
  clearCompleted(): void {
    this.clearResults();
  }

  /** Clears generated interview artefacts without wiping the resume queue. */
  clearInterviewResults(): void {
    this.structuredInterview.set(null);
    this.interviewAnalysis.set(null);
    this.interviewJdAnalysis.set(null);
    this.interviewError.set(null);
  }

  setInterviewGenerating(value: boolean): void {
    this.interviewGenerating.set(value);
  }

  setInterviewError(message: string | null): void {
    this.interviewError.set(message);
  }

  setInterviewResult(
    interview: StructuredInterview | null,
    analysis: Analysis | null,
    jdAnalysis: JdAnalysis | null
  ): void {
    this.structuredInterview.set(interview);
    this.interviewAnalysis.set(analysis);
    this.interviewJdAnalysis.set(jdAnalysis);
  }

  /** Downloads the interview transcript for a completed resume. */
  downloadTranscript(task: ResumeTask): void {
    if (!isPlatformBrowser(this.platformId) || !task.result) {
      return;
    }
    const transcriptPath = task.result.raw.transcriptPath;
    this.resumeService.downloadTranscript(transcriptPath).subscribe({
      next: (blob) => {
        this.triggerDownload(blob, this.safeName(task, 'Transcript.txt'));
      },
      error: (err) => {
        this.toastService.show('Unable to download transcript. Try again.');
      },
    });
  }

  /** Downloads the evaluation report for a completed resume. */
  downloadReport(task: ResumeTask): void {
    if (!isPlatformBrowser(this.platformId) || !task.result) {
      return;
    }
    if (this.downloadingReportId() === task.id) {
      return;
    }

    const reportPath = task.result.raw.reportPath as string | undefined;
    const reportFilename = task.result.raw.reportFilename as string | undefined;
    this.downloadingReportId.set(task.id);

    this.resumeService.downloadReport(reportPath).subscribe({
      next: (blob) => {
        const filename = this.safeName(task, 'Report.xlsx');
        this.triggerDownload(blob, filename);

        if ((!reportPath || !reportFilename) && task.result) {
          this.updateTask(task.id, {
            result: {
              ...task.result,
              raw: {
                ...task.result.raw,
                reportPath: filename,
                reportFilename: filename,
              },
            },
          });
        }
      },
      error: (err) => {
        const status = err?.status;
        if (status === 404) {
          this.toastService.show('Report not found. It may still be generating. Please try again in a moment.');
        } else if (status === 0 || status === undefined) {
          this.toastService.show('Backend unavailable. Please check the server and try again.');
        } else {
          this.toastService.show('Unable to download report. Try again.');
        }
        this.downloadingReportId.set(null);
      },
      complete: () => {
        this.downloadingReportId.set(null);
      },
    });
  }

  /** Triggers a browser download for the resume's podcast (server-hosted path). */
  downloadPodcast(task: ResumeTask): void {
    if (!isPlatformBrowser(this.platformId) || !task.result?.raw.podcastPath) {
      return;
    }
    const href = this.resolveMediaUrl(task.result.raw.podcastPath) || task.result.raw.podcastPath;
    const a = document.createElement('a');
    a.href = href;
    a.download = this.safeName(task, 'Podcast.mp3');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /** Downloads a single Excel report containing all completed candidates. */
  downloadBatchReport(): void {
    if (!isPlatformBrowser(this.platformId) || this.batchDownloading()) {
      return;
    }

    this.batchDownloading.set(true);
    this.resumeService.downloadBatchReport().subscribe({
      next: (blob) => {
        this.triggerDownload(blob, 'Batch_Evaluation_Report.xlsx');
      },
      error: (err) => {
        const status = err?.status;
        if (status === 404) {
          this.toastService.show('Batch report not found. Upload resumes to generate it.');
        } else if (status === 0 || status === undefined) {
          this.toastService.show('Backend unavailable. Please check the server and try again.');
        } else {
          this.toastService.show('Unable to download batch report. Try again.');
        }
        this.batchDownloading.set(false);
      },
      complete: () => this.batchDownloading.set(false),
    });
  }

  // --- Internals ---

  private processNext(): void {
    const next = this.taskList.find((t) => t.status === 'queued');
    if (!next) {
      this.finish();
      return;
    }

    if (!next.file) {
      this.updateTask(next.id, {
        status: 'failed',
        progress: 0,
        stageIndex: -1,
        error: 'Resume file is no longer available. Please re-upload this file.',
      });
      this.processNext();
      return;
    }

    this.updateTask(next.id, {
      status: 'processing',
      stageIndex: 0,
      progress: 5,
      elapsedSeconds: 0,
    });

    const stageTimer = this.createStageSimulation(next.id);
    const file = next.file;

    this.currentSubscription = this.resumeService.uploadResume(file)
      .pipe(
        map((response) => {
          if (!response.success) {
            throw new Error(response.message ?? 'Upload failed.');
          }
          const resumeId = response.resumeId || response.uploadId;
          if (response.uploadId || resumeId) {
            this.updateTask(next.id, {
              uploadId: response.uploadId,
              resumeId,
            });
          }
          const analysis = normalizeAnalysis(response.analysis);
          const evaluation = normalizeEvaluation(response.evaluation);
          const atsEvaluation = normalizeAts(response.atsEvaluation);
          if (!analysis || !evaluation) {
            throw new Error('Analysis from server was incomplete. Please try again.');
          }
          const raw: UploadResult = {
            ...response,
            podcastPath: this.resolveMediaUrl(response.podcastPath) ?? response.podcastPath ?? null,
            podcastScriptPath:
              this.resolveMediaUrl(response.podcastScriptPath) ?? response.podcastScriptPath ?? null,
          };
          return {
            raw,
            analysis,
            evaluation,
            atsEvaluation,
            parsedTranscript: parseTranscript(response.interviewTranscript),
          } as ResumeProcessedResult;
        }),
        catchError((err) => {
          stageTimer();
          const message =
            (err as { error?: { message?: string } })?.error?.message ??
            (err instanceof Error ? err.message : undefined) ??
            'Resume processing failed.';
          this.updateTask(next.id, {
            status: 'failed',
            progress: 0,
            stageIndex: -1,
            error: message,
          });
          return throwError(() => err);
        })
      )
      .subscribe({
        next: (result) => {
          stageTimer();
          const lastStage = RESUME_STAGES.length - 1;
          this.updateTask(next.id, {
            status: 'completed',
            progress: 100,
            stageIndex: lastStage,
            result,
          });
          // Poll for background task completion (podcast, email)
          const task = this.taskList.find((t) => t.id === next.id);
          const pollUploadId = task?.uploadId;
          const pollResumeId = task?.resumeId || task?.uploadId;
          if (pollUploadId && pollResumeId) {
            this.startStatusPolling(next.id, pollUploadId, pollResumeId);
          }
        },
        error: () => this.processNext(),
        complete: () => this.processNext(),
      });
  }

  /**
   * Prefix relative media paths (e.g. /output/podcast_….mp3) with the API host
   * so audio/downloads work when the UI and API are on different origins.
   */
  private resolveMediaUrl(path: string | null | undefined): string | null {
    if (!path) {
      return null;
    }
    if (/^https?:\/\//i.test(path)) {
      return withApiKeyQuery(path);
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return withApiKeyQuery(`${API_BASE}${normalized}`);
  }

  private startStatusPolling(taskId: string, uploadId: string, resumeId: string): void {
    if (this.pollingSubscriptions.has(taskId)) {
      return;
    }

    const subscription = interval(2000)
      .pipe(
        take(60),
        switchMap(() => this.resumeService.getUploadProgress(uploadId)),
        map((progress: UploadProgress) => {
          const resume =
            progress.resumes.find((r: UploadProgressResume) => r.resumeId === resumeId) ||
            (progress.resumes.length === 1 ? progress.resumes[0] : undefined);
          return resume ?? null;
        }),
        filter((resume): resume is UploadProgressResume => resume !== null)
      )
      .subscribe({
        next: (resume) => {
          const task = this.taskList.find((t) => t.id === taskId);
          if (!task || !task.result) return;

          const rawPatch: Record<string, unknown> = {};
          let changed = false;
          let terminal = false;

          const nextPodcast = this.resolveMediaUrl(resume.podcastPath);
          if (nextPodcast && task.result.raw['podcastPath'] !== nextPodcast) {
            rawPatch['podcastPath'] = nextPodcast;
            changed = true;
          }
          const nextScript = this.resolveMediaUrl(resume.podcastScriptPath);
          if (nextScript && task.result.raw['podcastScriptPath'] !== nextScript) {
            rawPatch['podcastScriptPath'] = nextScript;
            changed = true;
          }
          if (resume.emailSent !== undefined && task.result.raw['emailSent'] !== resume.emailSent) {
            rawPatch['emailSent'] = resume.emailSent;
            changed = true;
          }
          if (resume.emailSkipped !== undefined && task.result.raw['emailSkipped'] !== resume.emailSkipped) {
            rawPatch['emailSkipped'] = resume.emailSkipped;
            changed = true;
          }
          if (resume.emailError !== undefined && task.result.raw['emailError'] !== resume.emailError) {
            rawPatch['emailError'] = resume.emailError;
            changed = true;
          }

          const podcastReady = Boolean(nextPodcast || task.result.raw['podcastPath'] || resume.podcastPath);
          const emailSettled =
            resume.emailSent === true ||
            resume.emailSkipped === true ||
            Boolean(resume.emailError) ||
            task.result.raw['emailSent'] === true ||
            task.result.raw['emailSkipped'] === true;
          if (podcastReady && emailSettled) {
            terminal = true;
          }

          if (changed) {
            this.updateTask(taskId, {
              result: {
                ...task.result,
                raw: { ...task.result.raw, ...rawPatch },
              },
            });
          }

          if (terminal) {
            subscription.unsubscribe();
            this.pollingSubscriptions.delete(taskId);
          }
        },
        complete: () => {
          this.pollingSubscriptions.delete(taskId);
        },
        error: () => {
          this.pollingSubscriptions.delete(taskId);
        },
      });

    this.pollingSubscriptions.set(taskId, subscription);
  }

  /**
   * Simulates smooth stage progression for the active resume. The backend
   * returns a single response, so we animate the intermediate stages locally
   * to give clear visual feedback without polling.
   */
  private createStageSimulation(id: string): () => void {
    const totalStages = RESUME_STAGES.length - 1; // exclude final "Completed"
    let current = 0;
    const interval = setInterval(() => {
      const task = this.taskList.find((t) => t.id === id);
      if (!task || task.status !== 'processing') {
        clearInterval(interval);
        return;
      }
      if (current < totalStages) {
        current++;
        const progress = Math.min(95, Math.round(((current + 1) / totalStages) * 90) + 5);
        this.updateTask(id, { stageIndex: current, progress });
      }
    }, 1400);
    return () => clearInterval(interval);
  }

  private finish(): void {
    this.processing = false;
    this.isProcessing.set(false);
    this.currentSubscription = null;
    this.stopTimer();
    // Do not cancel background podcast/email polls here — they outlive the upload queue.
    this.emitOverall();
    this.maybeRankCandidates();
  }

  private maybeRankCandidates(): void {
    const jdAnalysis = this.jdAnalysis();
    if (!jdAnalysis) {
      return;
    }

    const completedTasks = this.taskList.filter((t) => t.status === 'completed' && t.result);
    if (completedTasks.length < 2) {
      return;
    }

    const candidates = completedTasks.map((t) => ({
      analysis: t.result!.analysis,
      evaluation: t.result!.evaluation,
    }));

    this.rankingInProgress.set(true);
    this.rankingError.set(null);

    this.resumeService.rankCandidates(jdAnalysis, candidates).subscribe({
      next: (response) => {
        this.rankingInProgress.set(false);
        if (response.success && response.candidateRanking) {
          this.candidateRanking.set(response.candidateRanking);
        } else {
          this.rankingError.set(response.message ?? 'Candidate ranking failed.');
        }
      },
      error: (err) => {
        this.rankingInProgress.set(false);
        const message =
          (err as { error?: { error?: string; message?: string } })?.error?.error ??
          (err as { error?: { message?: string } })?.error?.message ??
          'Candidate ranking failed.';
        this.rankingError.set(message);
      },
    });
  }

  private startTimer(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    if (this.timerSubscription) {
      return;
    }
    this.timerSubscription = new Observable<number>((sub) => {
      const handle = setInterval(() => sub.next(Date.now()), 1000);
      return () => clearInterval(handle);
    }).subscribe(() => {
      let changed = false;
      this.taskList = this.taskList.map((t) => {
        if (t.status === 'processing') {
          changed = true;
          return { ...t, elapsedSeconds: t.elapsedSeconds + 1 };
        }
        return t;
      });
      if (changed) {
        this.emitTasks();
        this.emitOverall();
      }
    });
  }

  private stopTimer(): void {
    this.timerSubscription?.unsubscribe();
    this.timerSubscription = null;
  }

  private renumber(): void {
    let seq = 0;
    this.taskList = this.taskList.map((t) => ({ ...t, order: ++seq }));
    this.orderSeq = seq;
  }

  private updateTask(id: string, patch: Partial<ResumeTask>): void {
    this.taskList = this.taskList.map((t) => (t.id === id ? { ...t, ...patch } : t));
    this.emitTasks();
    this.emitOverall();
  }

  private emitTasks(): void {
    this.tasks.set([...this.taskList]);
  }

  private emitOverall(): void {
    const completed = this.taskList.filter((t) => t.status === 'completed').length;
    const failed = this.taskList.filter((t) => t.status === 'failed').length;
    const elapsed = this.taskList.reduce((sum, t) => sum + t.elapsedSeconds, 0);
    this.overall.set({
      total: this.taskList.length,
      completed,
      failed,
      elapsedSeconds: elapsed,
    });
  }

  private triggerDownload(blob: Blob, filename: string): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    if (!blob || blob.size === 0) {
      this.toastService.show('Download failed: received an empty file.');
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (a.parentNode) {
        a.parentNode.removeChild(a);
      }
    }, 500);
  }

  private safeName(task: ResumeTask, suffix: string): string {
    const base = task.fileName.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_');
    return `${base}_${suffix}`;
  }

  // --- Session persistence (sessionStorage) ---

  private buildSessionSnapshot(): PersistedSession {
    return {
      version: SESSION_VERSION,
      tasks: this.taskList.map(({ file: _file, ...rest }) => ({ ...rest, file: null })),
      orderSeq: this.orderSeq,
      overall: this.overall(),
      jdFileMeta: this.jdFileMeta(),
      jdAnalysis: this.jdAnalysis(),
      candidateRanking: this.candidateRanking(),
      rankingError: this.rankingError(),
      showQueue: this.showQueue(),
      structuredInterview: this.structuredInterview(),
      interviewAnalysis: this.interviewAnalysis(),
      interviewJdAnalysis: this.interviewJdAnalysis(),
      interviewError: this.interviewError(),
    };
  }

  private persistToSession(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    try {
      const snapshot = this.buildSessionSnapshot();
      const hasContent =
        snapshot.tasks.length > 0 ||
        !!snapshot.jdAnalysis ||
        !!snapshot.candidateRanking ||
        !!snapshot.structuredInterview ||
        !!snapshot.jdFileMeta;
      if (!hasContent) {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        return;
      }
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // QuotaExceeded or private mode — ignore; in-memory state still works for navigation.
    }
  }

  private clearSessionStorage(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  private restoreFromSession(): void {
    if (!isPlatformBrowser(this.platformId) || this.taskList.length > 0) {
      return;
    }
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) {
      return;
    }

    try {
      const snapshot = JSON.parse(raw) as PersistedSession;
      if (!snapshot || snapshot.version !== SESSION_VERSION || !Array.isArray(snapshot.tasks)) {
        this.clearSessionStorage();
        return;
      }

      this.hydrating = true;

      this.taskList = snapshot.tasks.map((t) => {
        // Mid-flight tasks cannot resume without the File blob after a hard refresh.
        if (t.status === 'processing') {
          return {
            ...t,
            file: null,
            status: 'failed' as const,
            progress: 0,
            stageIndex: -1,
            error: t.error || 'Analysis was interrupted. Please re-upload and analyze again.',
          };
        }
        return { ...t, file: null };
      });
      this.orderSeq = typeof snapshot.orderSeq === 'number' ? snapshot.orderSeq : this.taskList.length;
      this.jdFile.set(null);
      this.jdFileMeta.set(snapshot.jdFileMeta ?? null);
      this.jdAnalysis.set(snapshot.jdAnalysis ?? null);
      this.candidateRanking.set(snapshot.candidateRanking ?? null);
      this.rankingError.set(snapshot.rankingError ?? null);
      this.rankingInProgress.set(false);
      this.structuredInterview.set(snapshot.structuredInterview ?? null);
      this.interviewAnalysis.set(snapshot.interviewAnalysis ?? null);
      this.interviewJdAnalysis.set(snapshot.interviewJdAnalysis ?? null);
      this.interviewError.set(snapshot.interviewError ?? null);
      this.interviewGenerating.set(false);
      this.processing = false;
      this.isProcessing.set(false);

      const shouldShowQueue =
        snapshot.showQueue ||
        this.taskList.length > 0 ||
        !!snapshot.structuredInterview ||
        !!snapshot.candidateRanking;
      this.showQueue.set(shouldShowQueue);

      this.emitTasks();
      if (snapshot.overall) {
        this.overall.set(snapshot.overall);
      } else {
        this.emitOverall();
      }
    } catch {
      this.clearSessionStorage();
    } finally {
      this.hydrating = false;
    }
  }
}
