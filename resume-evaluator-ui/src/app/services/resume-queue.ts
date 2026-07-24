import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subscription, throwError, interval } from 'rxjs';
import { catchError, map, switchMap, take, filter } from 'rxjs/operators';
import { ResumeService } from './resume';
import { ToastService } from './toast';
import {
  Analysis,
  AtsEvaluation,
  Evaluation,
  InterviewTranscript,
  InterviewTurn,
  RESUME_STAGES,
  ResumeProcessedResult,
  ResumeTask,
  UploadProgress,
  UploadProgressResume,
  UploadResult,
} from '../models';

const MAX_FILES = 5;
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

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

  const rawBreakdown = raw['atsBreakdown'] as Record<string, unknown> | undefined;
  const atsBreakdown: AtsEvaluation['atsBreakdown'] = {
    contactInformation: typeof rawBreakdown?.['contactInformation'] === 'number' ? rawBreakdown['contactInformation'] : 0,
    resumeStructure: typeof rawBreakdown?.['resumeStructure'] === 'number' ? rawBreakdown['resumeStructure'] : 0,
    skills: typeof rawBreakdown?.['skills'] === 'number' ? rawBreakdown['skills'] : 0,
    experience: typeof rawBreakdown?.['experience'] === 'number' ? rawBreakdown['experience'] : 0,
    education: typeof rawBreakdown?.['education'] === 'number' ? rawBreakdown['education'] : 0,
    keywordOptimization: typeof rawBreakdown?.['keywordOptimization'] === 'number' ? rawBreakdown['keywordOptimization'] : 0,
    formatting: typeof rawBreakdown?.['formatting'] === 'number' ? rawBreakdown['formatting'] : 0,
  };

  return {
    atsScore,
    atsGrade: raw['atsGrade'] ? String(raw['atsGrade']) : "",
    atsSummary: raw['atsSummary'] ? String(raw['atsSummary']) : "ATS evaluation unavailable",
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
        return `"${file.name}" exceeds the 10MB limit.`;
      }
    }
    return null;
  }

  /** Adds valid PDF files to the selection queue (does not start processing). */
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
    this.emitTasks();
    return null;
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
  }

  /** Clears all tasks and resets the service state. */
  reset(): void {
    this.currentSubscription?.unsubscribe();
    this.currentSubscription = null;
    this.stopTimer();
    this.pollingSubscriptions.forEach((sub) => sub.unsubscribe());
    this.pollingSubscriptions.clear();
    this.taskList = [];
    this.orderSeq = 0;
    this.processing = false;
    this.emitTasks();
    this.isProcessing.set(false);
    this.emitOverall();
  }

  /** Starts sequential processing of all queued resumes. */
  start(): void {
    if (this.processing) {
      return;
    }
    this.currentSubscription?.unsubscribe();
    const hasQueued = this.taskList.some((t) => t.status === 'queued');
    if (!hasQueued) {
      return;
    }
    this.processing = true;
    this.isProcessing.set(true);
    this.startTimer();
    this.processNext();
  }

  /** Clears tasks only after they have all finished (completed/failed). */
  clearCompleted(): void {
    if (this.processing) {
      return;
    }
    this.reset();
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
    const a = document.createElement('a');
    a.href = task.result.raw.podcastPath;
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

    this.updateTask(next.id, {
      status: 'processing',
      stageIndex: 0,
      progress: 5,
      elapsedSeconds: 0,
    });

    const stageTimer = this.createStageSimulation(next.id);

    this.currentSubscription = this.resumeService.uploadResume(next.file)
      .pipe(
        map((response) => {
          if (!response.success) {
            throw new Error(response.message ?? 'Upload failed.');
          }
          if (response.uploadId) {
            this.updateTask(next.id, { uploadId: response.uploadId });
          }
          const analysis = normalizeAnalysis(response.analysis);
          const evaluation = normalizeEvaluation(response.evaluation);
          const atsEvaluation = normalizeAts(response.atsEvaluation);
          if (!analysis || !evaluation) {
            throw new Error('Analysis from server was incomplete. Please try again.');
          }
          return {
            raw: response,
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
          if (task?.uploadId) {
            this.startStatusPolling(next.id, task.uploadId);
          }
        },
        error: () => this.processNext(),
        complete: () => this.processNext(),
      });
  }

  private startStatusPolling(taskId: string, uploadId: string): void {
    if (this.pollingSubscriptions.has(taskId)) {
      return;
    }

    const subscription = interval(2000)
        .pipe(
        take(60),
        switchMap(() => this.resumeService.getUploadProgress(uploadId)),
        map((progress: UploadProgress) => {
          const resume = progress.resumes.find((r: UploadProgressResume) => r.resumeId === taskId);
          if (!resume) return null;
          return resume;
        }),
        filter((resume): resume is UploadProgressResume => resume !== null)
      )
      .subscribe({
        next: (resume) => {
          const task = this.taskList.find((t) => t.id === taskId);
          if (!task || !task.result) return;

          const rawPatch: Record<string, unknown> = {};
          let changed = false;

          if (resume.podcastPath && task.result.raw['podcastPath'] !== resume.podcastPath) {
            rawPatch['podcastPath'] = resume.podcastPath;
            changed = true;
          }
          if (resume.podcastScriptPath && task.result.raw['podcastScriptPath'] !== resume.podcastScriptPath) {
            rawPatch['podcastScriptPath'] = resume.podcastScriptPath;
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

          if (changed) {
            this.updateTask(taskId, {
              result: {
                ...task.result,
                raw: { ...task.result.raw, ...rawPatch },
              },
            });
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
    this.pollingSubscriptions.forEach((sub) => sub.unsubscribe());
    this.pollingSubscriptions.clear();
    this.emitOverall();
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
}
