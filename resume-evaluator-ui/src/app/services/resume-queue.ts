import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Observable, Subscription, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ResumeService } from './resume';
import { ToastService } from './toast';
import {
  Analysis,
  Evaluation,
  InterviewTranscript,
  InterviewTurn,
  RESUME_STAGES,
  ResumeProcessedResult,
  ResumeTask,
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
    yearsOfExperience: String(raw['yearsOfExperience'] ?? raw['yoe'] ?? raw['years_of_experience'] ?? ''),
    skills: Array.isArray(raw['skills']) ? raw['skills'].map(String) : [],
    experience: String(raw['experience'] ?? ''),
    strengths: Array.isArray(raw['strengths']) ? raw['strengths'].map(String) : [],
    weaknesses: Array.isArray(raw['weaknesses']) ? raw['weaknesses'].map(String) : [],
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

  return {
    score,
    skills: Array.isArray(raw['skills']) ? raw['skills'].map(String) : [],
    strengths: Array.isArray(raw['strengths']) ? raw['strengths'].map(String) : [],
    weaknesses: Array.isArray(raw['weaknesses']) ? raw['weaknesses'].map(String) : [],
    result: String(raw['result'] ?? raw['recommendation'] ?? ''),
    recommendation: raw['recommendation'] ? String(raw['recommendation']) : undefined,
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

    const rawTurns = data?.['transcriptTurns'];
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
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        return `"${file.name}" is not a PDF file.`;
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
          const analysis = normalizeAnalysis(response.analysis);
          const evaluation = normalizeEvaluation(response.evaluation);
          if (!analysis || !evaluation) {
            throw new Error('Analysis from server was incomplete. Please try again.');
          }
          return {
            raw: response,
            analysis,
            evaluation,
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
            progress: 100,
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
        },
        error: () => this.processNext(),
        complete: () => this.processNext(),
      });
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
      document.body.removeChild(a);
    }, 100);
  }

  private safeName(task: ResumeTask, suffix: string): string {
    const base = task.fileName.replace(/\.pdf$/i, '').replace(/[^\w.-]+/g, '_');
    return `${base}_${suffix}`;
  }
}
