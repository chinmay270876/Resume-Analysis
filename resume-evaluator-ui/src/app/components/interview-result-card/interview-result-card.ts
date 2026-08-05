import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  InterviewEvaluation,
  InterviewResultHistoryEntry,
  ScheduledInterview,
  ScoreWithReason,
} from '../../models';

@Component({
  selector: 'app-interview-result-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './interview-result-card.html',
  styleUrl: './interview-result-card.css',
})
export class InterviewResultCard {
  @Input() interview: ScheduledInterview | null = null;
  @Input() jobRole = '—';
  @Input() currentCompany = '—';
  @Input() transcriptDownloadHref: string | null = null;
  @Input() recordingDownloadHref: string | null = null;
  @Input() evaluationDownloadHref: string | null = null;
  @Input() resultReportDownloadHref: string | null = null;
  @Input() hasTranscript = false;
  @Input() hasRecording = false;

  @Output() viewTranscript = new EventEmitter<void>();
  @Output() viewEvaluation = new EventEmitter<void>();
  @Output() shareReport = new EventEmitter<void>();

  protected get evaluation(): InterviewEvaluation | null {
    const value = this.interview?.evaluation;
    if (!value || typeof value !== 'object') return null;
    return value;
  }

  /** Result is ready only after evaluation + hiring decision. */
  protected get isResultReady(): boolean {
    const item = this.interview;
    if (!item) return false;
    return (
      item.status === 'Result Generated' ||
      (!!this.evaluation &&
        (item.result === 'Selected' || item.result === 'Rejected'))
    );
  }

  protected get isPending(): boolean {
    return !this.isResultReady;
  }

  protected get resultLabel(): string {
    if (this.isPending) return 'Pending';
    return String(this.interview?.result || this.evaluation?.result || 'Pending');
  }

  protected resultClass(result?: string | null): string {
    const value = (result || 'Pending').toLowerCase();
    if (value === 'selected') return 'result-selected';
    if (value === 'rejected') return 'result-rejected';
    return 'result-pending';
  }

  protected statusClass(status: string | undefined): string {
    const value = (status || '').toLowerCase();
    if (value.includes('cancel')) return 'status-cancelled';
    if (
      value.includes('complete') ||
      value.includes('transcript') ||
      value.includes('evaluation') ||
      value.includes('result generated')
    ) {
      return 'status-completed';
    }
    if (value.includes('progress')) return 'status-progress';
    if (value.includes('reminder')) return 'status-reminder';
    return 'status-scheduled';
  }

  protected categoryScore(
    nested: ScoreWithReason | number | null | undefined,
    flat: number | null | undefined
  ): number | null {
    if (nested && typeof nested === 'object' && nested.score != null) {
      return nested.score;
    }
    if (typeof nested === 'number') return nested;
    if (flat != null) return flat;
    return null;
  }

  protected displayScore(value: number | null | undefined, suffix = ''): string {
    if (value == null) return '—';
    return `${value}${suffix}`;
  }

  protected formatDate(date: string | null | undefined): string {
    if (!date) return '—';
    try {
      const d = new Date(date + 'T00:00:00');
      if (Number.isNaN(d.getTime())) return date;
      return d.toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return date;
    }
  }

  protected formatTime(time: string | null | undefined): string {
    if (!time) return '—';
    const match = String(time).match(/^(\d{1,2}):(\d{2})/);
    if (!match) return time;
    let hours = Number(match[1]);
    const minutes = match[2];
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
  }

  protected formatDuration(): string {
    const item = this.interview;
    if (!item) return '—';
    const metaSec = item.transcriptMeta?.duration;
    if (metaSec != null && Number.isFinite(metaSec)) {
      const m = Math.floor(metaSec / 60);
      const s = Math.round(metaSec % 60);
      return `${m}m ${String(s).padStart(2, '0')}s`;
    }
    return `${item.durationMinutes || 0} minutes (scheduled)`;
  }

  protected summaryText(): string {
    const summary = this.evaluation?.summary?.trim();
    if (!summary) {
      if (this.isPending) {
        return 'Final result will appear after the interview is completed, the podcast transcript is generated, and AI evaluation finishes.';
      }
      return 'No recruiter summary available for this evaluation.';
    }
    const words = summary.split(/\s+/).filter(Boolean);
    if (words.length <= 250) return summary;
    return `${words.slice(0, 250).join(' ')}…`;
  }

  protected historyEntries(): InterviewResultHistoryEntry[] {
    const history = this.interview?.resultHistory;
    if (!Array.isArray(history)) return [];
    return [...history].reverse();
  }

  protected trackByGeneratedAt(_index: number, entry: InterviewResultHistoryEntry): string {
    return `${entry.evaluationId}-${entry.generatedAt}`;
  }

  protected onShare(): void {
    this.shareReport.emit();
  }
}
