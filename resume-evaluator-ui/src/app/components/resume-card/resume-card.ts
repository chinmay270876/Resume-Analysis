import { Component, Input, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  RESUME_STAGES,
  ResumeStatus,
  ResumeTask,
} from '../../models';
import { AnalysisCard } from '../analysis-card/analysis-card';
import { EvaluationCard } from '../evaluation-card/evaluation-card';
import { CollapsibleSection } from '../collapsible-section/collapsible-section';

interface StatusMeta {
  label: string;
  tone: ResumeStatus;
}

@Component({
  selector: 'app-resume-card',
  standalone: true,
  imports: [CommonModule, AnalysisCard, EvaluationCard, CollapsibleSection],
  templateUrl: './resume-card.html',
  styleUrl: './resume-card.css',
})
export class ResumeCard {
  readonly task = input.required<ResumeTask>();
  @Input() canRemove = true;
  readonly downloadingReportId = input<string | null>(null);

  readonly remove = output<string>();
  readonly downloadReport = output<ResumeTask>();
  readonly downloadPodcast = output<ResumeTask>();

  protected readonly stages = RESUME_STAGES;

  protected readonly statusMeta = computed<StatusMeta>(() => {
    switch (this.task().status) {
      case 'processing':
        return { label: 'Processing', tone: 'processing' };
      case 'completed':
        return { label: 'Completed', tone: 'completed' };
      case 'failed':
        return { label: 'Failed', tone: 'failed' };
      default:
        return { label: 'Queued', tone: 'queued' };
    }
  });

  protected readonly isProcessing = computed(() => this.task().status === 'processing');
  protected readonly isCompleted = computed(() => this.task().status === 'completed');
  protected readonly isFailed = computed(() => this.task().status === 'failed');
  protected readonly isQueued = computed(() => this.task().status === 'queued');

  protected readonly formattedTime = computed(() =>
    this.formatTime(this.task().elapsedSeconds)
  );

  protected readonly completedLabel = computed(() => {
    if (!this.isCompleted()) {
      return '';
    }
    return `✓ Completed in ${this.formatTime(this.task().elapsedSeconds)}`;
  });

  protected readonly candidateName = computed(
    () => this.task().result?.analysis.candidateName || this.task().fileName
  );

  protected readonly overallScore = computed(
    () => this.task().result?.evaluation.score ?? null
  );

  protected readonly recommendation = computed(
    () =>
      this.task().result?.evaluation.recommendation ??
      this.task().result?.evaluation.result ??
      ''
  );

  protected readonly isPass = computed(() => {
    const r = (this.recommendation() || '').toUpperCase();
    return r === 'PASS' || r.includes('SELECTED') || r.includes('HIRE');
  });

  protected readonly result = computed(() => this.task().result);

  protected readonly atsEvaluation = computed(() => this.task().result?.atsEvaluation ?? null);

  protected readonly isDownloadingReport = computed(() => this.downloadingReportId() === this.task().id);

  protected readonly reportReady = computed(() => {
    const raw = this.result()?.raw;
    return !!raw && (!!raw.reportPath || !!raw.reportFilename);
  });

  protected readonly reportButtonLabel = computed(() => {
    if (this.isDownloadingReport()) {
      return 'Downloading...';
    }
    if (this.reportReady()) {
      return 'Report Ready';
    }
    return 'Download Report';
  });

  /** Show section shells once this resume is actively processing or finished. */
  protected readonly showResultSections = computed(
    () => this.isProcessing() || this.isCompleted() || this.isFailed()
  );

  protected readonly analysisReady = computed(() => !!this.result()?.analysis);

  protected readonly evaluationReady = computed(() => !!this.result()?.evaluation);

  protected readonly sectionError = computed(() =>
    this.isFailed() ? this.task().error : null
  );

  protected readonly podcastReady = computed(() => !!this.result()?.raw?.podcastPath);

  /** Keep Podcast visible while processing, or once a path exists. */
  protected readonly showPodcastSection = computed(
    () => this.isProcessing() || this.podcastReady()
  );

  protected readonly podcastWaiting = computed(
    () => this.isProcessing() && !this.podcastReady()
  );

  protected stageState(index: number): 'done' | 'active' | 'pending' {
    const current = this.task().stageIndex;
    if (this.isCompleted() || this.isFailed()) {
      if (this.isCompleted()) {
        return index <= current ? 'done' : 'pending';
      }
      return index < current ? 'done' : 'pending';
    }
    if (current < 0) {
      return 'pending';
    }
    if (index < current) {
      return 'done';
    }
    if (index === current) {
      return 'active';
    }
    return 'pending';
  }

  protected onRemove(): void {
    this.remove.emit(this.task().id);
  }

  protected onDownloadReport(): void {
    this.downloadReport.emit(this.task());
  }

  protected onDownloadPodcast(): void {
    this.downloadPodcast.emit(this.task());
  }

  private formatTime(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }
}
