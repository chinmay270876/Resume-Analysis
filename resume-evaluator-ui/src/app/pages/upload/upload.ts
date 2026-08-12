import { Component, computed, inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ResumeQueueService } from '../../services/resume-queue';
import { ResumeTask, RankedCandidate, StructuredInterview } from '../../models';
import { ResumeCard } from '../../components/resume-card/resume-card';
import { InterviewQuestionsCard } from '../../components/interview-questions-card/interview-questions-card';
import { InterviewScheduler } from '../../components/interview-scheduler/interview-scheduler';
import { CollapsibleSection } from '../../components/collapsible-section/collapsible-section';
import { ToastService } from '../../services/toast';

/** Feature-card navigation targets that map to on-page result sections. */
export type FeatureSection =
  | 'analysis'
  | 'interview'
  | 'scoring'
  | 'ranking'
  | 'podcast';

interface FeatureCardDef {
  section: FeatureSection;
  icon: string;
  title: string;
  description: string;
}

const FEATURE_SECTION_IDS: Record<FeatureSection, string> = {
  analysis: 'section-analysis',
  interview: 'section-interview',
  scoring: 'section-scoring',
  ranking: 'section-ranking',
  podcast: 'section-podcast',
};

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    ResumeCard,
    InterviewQuestionsCard,
    InterviewScheduler,
    CollapsibleSection,
  ],
  templateUrl: './upload.html',
  styleUrl: './upload.css',
})
export class Upload implements OnInit {
  private readonly queue = inject(ResumeQueueService);
  private readonly toast = inject(ToastService);
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
  protected readonly activeSection = signal<FeatureSection | null>(null);

  /** True when at least one resume has finished with usable analysis results. */
  protected readonly isAnalysisComplete = computed(() => {
    if (this.isProcessing()) {
      return false;
    }
    return this.tasks().some(
      (t) => t.status === 'completed' && !!t.result?.analysis
    );
  });

  protected readonly featureCards: FeatureCardDef[] = [
    {
      section: 'analysis',
      icon: '📄',
      title: 'Resume Analysis',
      description: 'AI extracts skills, experience and strengths instantly.',
    },
    {
      section: 'interview',
      icon: '🎤',
      title: 'Interview Generator',
      description: 'Build a structured 25-minute interview from the Job Description.',
    },
    {
      section: 'scoring',
      icon: '📊',
      title: 'Candidate Scoring',
      description: 'Evaluate candidates using structured AI metrics.',
    },
    {
      section: 'ranking',
      icon: '🏆',
      title: 'Candidate Ranking',
      description: 'Compare multiple candidates against a Job Description and rank by fit.',
    },
    {
      section: 'podcast',
      icon: '🎧',
      title: 'Podcast Creation',
      description: 'Convert interviews into engaging audio reports.',
    },
  ];

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

  protected onCardClick(section: FeatureSection): void {
    if (!this.isAnalysisComplete()) {
      this.toast.show('Complete resume analysis first to unlock these features.', 'info', 3500);
      return;
    }
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.activeSection.set(section);
    const el = this.resolveSectionElement(section);
    if (!el) {
      this.toast.show('That section is not available yet for this session.', 'info', 3500);
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  protected onCardKeydown(event: KeyboardEvent, section: FeatureSection): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.onCardClick(section);
    }
  }

  private resolveSectionElement(section: FeatureSection): HTMLElement | null {
    const primaryId = FEATURE_SECTION_IDS[section];
    const primary = document.getElementById(primaryId);
    if (primary) {
      return primary;
    }

    // Fallbacks when a dedicated wrapper is absent but related content exists.
    if (section === 'interview') {
      return (
        document.getElementById('section-interview') ||
        document.querySelector<HTMLElement>('[id^="interview-questions-"]') ||
        document.getElementById('schedule-interview')
      );
    }
    if (section === 'ranking') {
      return document.getElementById('candidate-ranking');
    }
    if (section === 'analysis' || section === 'scoring' || section === 'podcast') {
      return document.getElementById('section-results');
    }
    return null;
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
    if (!this.isProcessing() && !this.interviewGenerating()) {
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
    if (!this.isProcessing() && !this.interviewGenerating() && this.tasks().length < this.maxFiles) {
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
    this.activeSection.set(null);
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

  /** Tasks that have a per-candidate structured interview question bank. */
  protected tasksWithInterview(): ResumeTask[] {
    return this.tasks().filter((t) => !!t.structuredInterview);
  }

  /** True when at least one task carries its own interview plan (multi-resume path). */
  protected hasTaskInterviews(): boolean {
    return this.tasksWithInterview().length > 0;
  }

  /** Ranking section appears while ranking runs, succeeds, or fails. */
  protected showRankingSection(): boolean {
    return this.rankingInProgress() || !!this.candidateRanking() || !!this.rankingError();
  }

  /**
   * Per-candidate interview shells: shown while generating or once a result/error exists.
   * Keeps candidates independent so one ready interview is viewable while others wait.
   */
  protected interviewSectionTasks(): ResumeTask[] {
    if (!this.hasJobDescription() && !this.interviewGenerating()) {
      // Still show tasks that already have interview data (e.g. session restore).
      return this.tasks().filter((t) => !!t.structuredInterview || !!t.interviewGenError);
    }
    return this.tasks().filter(
      (t) =>
        t.status === 'completed' &&
        !!t.result &&
        (this.interviewGenerating() || !!t.structuredInterview || !!t.interviewGenError)
    );
  }

  protected interviewSectionTitle(task: ResumeTask): string {
    const name = this.candidateInterviewLabel(task);
    return this.interviewSectionTasks().length > 1
      ? `Interview Questions — ${name}`
      : 'Interview Questions';
  }

  protected interviewSectionWaiting(task: ResumeTask): boolean {
    return this.interviewGenerating() && !task.structuredInterview && !task.interviewGenError;
  }

  protected interviewSectionError(task: ResumeTask): string | null {
    return task.interviewGenError || null;
  }

  protected candidateInterviewLabel(task: ResumeTask): string {
    return task.result?.analysis?.candidateName || task.fileName;
  }

  protected asStructuredInterview(value: StructuredInterview | null | undefined): StructuredInterview | null {
    return value ?? null;
  }

  protected schedulerResumeId(): string | null {
    const fromQueue = this.queue.interviewResumeId();
    if (fromQueue) {
      return fromQueue;
    }
    const owner = this.tasks().find((t) => !!t.structuredInterview);
    if (owner) {
      return owner.resumeId || owner.uploadId || null;
    }
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
