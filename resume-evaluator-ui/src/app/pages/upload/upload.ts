import { Component, inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ResumeQueueService } from '../../services/resume-queue';
import { ResumeService } from '../../services/resume';
import { Analysis, JdAnalysis, ResumeTask, RankedCandidate, StructuredInterview } from '../../models';
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
  protected readonly jdAnalysis = this.queue.jdAnalysis;
  protected readonly candidateRanking = this.queue.candidateRanking;
  protected readonly rankingInProgress = this.queue.rankingInProgress;
  protected readonly rankingError = this.queue.rankingError;

  protected readonly isDragOver = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showQueue = signal(false);
  protected readonly isDarkMode = signal(true);

  protected readonly interviewGenerating = signal(false);
  protected readonly interviewError = signal<string | null>(null);
  protected readonly structuredInterview = signal<StructuredInterview | null>(null);
  protected readonly interviewAnalysis = signal<Analysis | null>(null);
  protected readonly interviewJdAnalysis = signal<JdAnalysis | null>(null);

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.resetSession();
      const savedTheme = localStorage.getItem('theme');
      const isDark = savedTheme !== 'light';
      this.isDarkMode.set(isDark);
      this.applyTheme(isDark);
    }
  }

  /**
   * Clears the in-memory upload queue on page load. Does NOT wipe the shared
   * Excel workbook — that would destroy other users'/tabs' report data.
   * Use the reset-report API explicitly when an admin needs a clean workbook.
   */
  private resetSession(): void {
    this.queue.reset();
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
    this.showQueue.set(true);
  }

  protected removeResume(id: string): void {
    this.queue.removeTask(id);
    if (this.tasks().length === 0) {
      this.showQueue.set(false);
    }
  }

  protected startProcessing(): void {
    this.error.set(null);
    this.queue.start();
  }

  protected resetAll(): void {
    this.queue.clearCompleted();
    this.showQueue.set(false);
    this.error.set(null);
    this.structuredInterview.set(null);
    this.interviewAnalysis.set(null);
    this.interviewJdAnalysis.set(null);
    this.interviewError.set(null);
  }

  protected canGenerateInterview(): boolean {
    return !this.isProcessing()
      && !this.interviewGenerating()
      && this.tasks().length >= 1
      && !!this.jdFile();
  }

  protected generateInterview(): void {
    const resumeTask = this.tasks()[0];
    const jd = this.jdFile();

    if (!resumeTask?.file) {
      this.interviewError.set('Resume file is required to generate an interview.');
      return;
    }
    if (!jd) {
      this.interviewError.set('Job description file is required to generate an interview.');
      return;
    }

    this.interviewError.set(null);
    this.structuredInterview.set(null);
    this.interviewAnalysis.set(null);
    this.interviewJdAnalysis.set(null);
    this.interviewGenerating.set(true);

    this.resumeService.generateInterview(resumeTask.file, jd).subscribe({
      next: (result) => {
        this.interviewGenerating.set(false);
        if (result?.success && result.interview) {
          this.structuredInterview.set(result.interview);
          this.interviewAnalysis.set(
            result.analysis || resumeTask.result?.analysis || null
          );
          this.interviewJdAnalysis.set(
            result.jdAnalysis || this.jdAnalysis() || null
          );
        } else {
          this.interviewError.set(result?.error || result?.message || 'Failed to generate interview.');
        }
      },
      error: (err: HttpErrorResponse) => {
        this.interviewGenerating.set(false);
        const body = err?.error;
        const message = body?.error || body?.message || err?.message || 'Failed to generate interview.';
        this.interviewError.set(message);
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
      this.structuredInterview.set(null);
      this.interviewAnalysis.set(null);
      this.interviewJdAnalysis.set(null);
      this.interviewError.set(null);
    }
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
