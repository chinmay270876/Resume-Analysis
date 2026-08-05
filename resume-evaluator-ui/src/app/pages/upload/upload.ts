import { Component, inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ResumeQueueService } from '../../services/resume-queue';
import { ResumeService } from '../../services/resume';
import { ResumeTask, RankedCandidate } from '../../models';
import { ResumeCard } from '../../components/resume-card/resume-card';
import { InterviewQuestionsCard } from '../../components/interview-questions-card/interview-questions-card';
import { InterviewScheduler } from '../../components/interview-scheduler/interview-scheduler';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [CommonModule, RouterLink, ResumeCard, InterviewQuestionsCard, InterviewScheduler],
  templateUrl: './upload.html',
  styleUrl: './upload.css',
})
export class Upload implements OnInit {
  private readonly queue = inject(ResumeQueueService);
  private readonly resumeService = inject(ResumeService);
  private readonly platformId = inject(PLATFORM_ID);

  protected readonly tasks = this.queue.tasks;
  protected readonly isProcessing = this.queue.isProcessing;
  protected readonly overall = this.queue.overall;
  protected readonly maxFiles = this.queue.maxFiles;
  protected readonly downloadingBatch = this.queue.batchDownloading;
  protected readonly downloadingReportId = this.queue.downloadingReportId;
  protected readonly jdFile = this.queue.jdFile;
  protected readonly jdFileMeta = this.queue.jdFileMeta;
  protected readonly jdAnalysis = this.queue.jdAnalysis;
  protected readonly candidateRanking = this.queue.candidateRanking;
  protected readonly rankingInProgress = this.queue.rankingInProgress;
  protected readonly rankingError = this.queue.rankingError;
  protected readonly showQueue = this.queue.showQueue;

  protected readonly interviewGenerating = this.queue.interviewGenerating;
  protected readonly interviewError = this.queue.interviewError;
  protected readonly structuredInterview = this.queue.structuredInterview;
  protected readonly interviewAnalysis = this.queue.interviewAnalysis;
  protected readonly interviewJdAnalysis = this.queue.interviewJdAnalysis;

  protected readonly isDragOver = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly isDarkMode = signal(true);

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      // Do NOT reset the analysis session on route enter — ResumeQueueService
      // holds (and sessionStorage restores) results across in-app navigation.
      const savedTheme = localStorage.getItem('theme');
      const isDark = savedTheme !== 'light';
      this.isDarkMode.set(isDark);
      this.applyTheme(isDark);
    }
  }

  protected toggleTheme(): void {
    const newIsDark = !this.isDarkMode();
    this.isDarkMode.set(newIsDark);
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem('theme', newIsDark ? 'dark' : 'light');
      this.applyTheme(newIsDark);
    }
  }

  private applyTheme(isDark: boolean): void {
    if (isDark) {
      document.body.classList.remove('light-mode');
    } else {
      document.body.classList.add('light-mode');
    }
  }

  protected onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length) {
      this.handleFiles(files);
    }
    input.value = '';
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      this.handleFiles(files);
    }
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isProcessing()) {
      this.isDragOver.set(true);
    }
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  protected onZoneKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      input?.click();
    }
  }

  protected onZoneClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('label') || target?.tagName === 'INPUT') {
      return;
    }
    if (!this.isProcessing() && this.tasks().length < this.maxFiles) {
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      input?.click();
    }
  }

  private handleFiles(files: FileList | File[]): void {
    const error = this.queue.addFiles(files);
    if (error) {
      this.error.set(error);
      return;
    }
    this.error.set(null);
  }

  protected removeResume(id: string): void {
    this.queue.removeTask(id);
  }

  protected startProcessing(): void {
    this.error.set(null);
    this.queue.start();
  }

  /** Explicit user action: wipe all Resume Analysis state and sessionStorage. */
  protected clearResults(): void {
    this.queue.clearResults();
    this.error.set(null);
  }

  protected canGenerateInterview(): boolean {
    return !this.isProcessing()
      && !this.interviewGenerating()
      && !!this.jdFile();
  }

  protected generateInterview(): void {
    const resumeTask = this.tasks()[0];
    const jd = this.jdFile();

    if (!jd) {
      this.queue.setInterviewError('Job description file is required to generate an interview.');
      return;
    }

    this.queue.setInterviewError(null);
    this.queue.setInterviewResult(null, null, null);
    this.queue.setInterviewGenerating(true);

    // JD-primary interview plan; first uploaded resume personalizes questions + gap analysis.
    this.resumeService.generateInterview(jd, resumeTask?.file ?? null).subscribe({
      next: (result) => {
        this.queue.setInterviewGenerating(false);
        if (result?.success && result.interview) {
          this.queue.setInterviewResult(
            result.interview,
            result.analysis || null,
            result.jdAnalysis || this.jdAnalysis() || null
          );
        } else {
          this.queue.setInterviewError(result?.error || result?.message || 'Failed to generate interview.');
        }
      },
      error: (err: HttpErrorResponse) => {
        this.queue.setInterviewGenerating(false);
        const body = err?.error;
        const message = body?.error || body?.message || err?.message || 'Failed to generate interview.';
        this.queue.setInterviewError(message);
      },
    });
  }

  protected onDownloadReport(task: ResumeTask): void {
    this.queue.downloadReport(task);
  }

  protected onDownloadPodcast(task: ResumeTask): void {
    this.queue.downloadPodcast(task);
  }

  protected onJdSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      const error = this.queue.setJobDescription(file);
      if (error) {
        this.error.set(error);
      } else {
        this.error.set(null);
      }
    }
    input.value = '';
  }

  protected removeJobDescription(): void {
    if (!this.isProcessing() && !this.interviewGenerating()) {
      this.queue.removeJobDescription();
    }
  }

  protected hasJobDescription(): boolean {
    return !!this.jdFile() || !!this.jdFileMeta();
  }

  protected jdDisplayName(): string {
    return this.jdFile()?.name ?? this.jdFileMeta()?.name ?? '';
  }

  protected jdDisplaySizeMb(): string {
    const size = this.jdFile()?.size ?? this.jdFileMeta()?.size ?? 0;
    return (size / 1024 / 1024).toFixed(2);
  }

  protected schedulerResumeId(): string | null {
    const task = this.tasks()[0];
    return task?.resumeId || task?.uploadId || null;
  }

  protected recommendationClass(recommendation: string): string {
    const value = recommendation.toLowerCase();
    if (value.includes('shortlist')) return 'rec-shortlist';
    if (value.includes('hold')) return 'rec-hold';
    return 'rec-reject';
  }

  protected trackByRank(index: number, entry: RankedCandidate): number {
    return entry.rank;
  }

  protected onDownloadBatchReport(): void {
    this.queue.downloadBatchReport();
  }

  protected overallProgress(): number {
    const o = this.overall();
    if (o.total === 0) {
      return 0;
    }
    return Math.round((o.completed / o.total) * 100);
  }

  protected formatTime(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  protected trackByTask(index: number, task: ResumeTask): string {
    return task.id;
  }
}
