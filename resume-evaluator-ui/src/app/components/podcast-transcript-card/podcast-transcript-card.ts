import {
  Component,
  Input,
  OnChanges,
  PLATFORM_ID,
  SimpleChanges,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { PodcastTranscript, PodcastTranscriptLine } from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';
import { extractApiErrorMessage } from '../../utils/api-error';

@Component({
  selector: 'app-podcast-transcript-card',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './podcast-transcript-card.html',
  styleUrl: './podcast-transcript-card.css',
})
export class PodcastTranscriptCard implements OnChanges {
  private readonly interviewService = inject(InterviewService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);

  @Input({ required: true }) interviewId!: string;
  /** When false, show empty state without calling the API. */
  @Input() interviewCompleted = false;
  @Input() hasRecording = false;

  protected readonly loading = signal(false);
  protected readonly available = signal(false);
  protected readonly transcript = signal<PodcastTranscript | null>(null);
  protected readonly lines = signal<PodcastTranscriptLine[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly searchQuery = signal('');
  protected readonly speakerFilter = signal('');
  protected readonly copying = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (changes['interviewId'] || changes['interviewCompleted']) {
      this.reload();
    }
  }

  protected reload(): void {
    if (!this.interviewId || !this.interviewCompleted) {
      this.available.set(false);
      this.transcript.set(null);
      this.lines.set([]);
      this.error.set(null);
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.error.set(null);
    this.interviewService
      .getTranscript(this.interviewId, {
        q: this.searchQuery() || undefined,
        speaker: this.speakerFilter() || undefined,
      })
      .subscribe({
        next: (result) => {
          this.loading.set(false);
          this.available.set(!!result.available && !!result.transcript);
          this.transcript.set(result.transcript || null);
          this.lines.set(result.transcript?.lines || []);
          if (!result.available) {
            this.error.set(null);
          }
        },
        error: (err: HttpErrorResponse) => {
          this.loading.set(false);
          this.available.set(false);
          this.error.set(extractApiErrorMessage(err, 'Failed to load transcript.'));
        },
      });
  }

  protected onSearch(): void {
    this.reload();
  }

  protected clearSearch(): void {
    this.searchQuery.set('');
    this.speakerFilter.set('');
    this.reload();
  }

  protected download(format: 'txt' | 'pdf'): void {
    if (!this.interviewId || !this.available()) return;
    const url = this.interviewService.transcriptDownloadUrl(this.interviewId, format);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  protected downloadAudio(): void {
    if (!this.interviewId || !this.hasRecording) return;
    const url = this.interviewService.recordingDownloadUrl(this.interviewId);
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  protected async copyTranscript(): Promise<void> {
    const lines = this.lines();
    if (!lines.length) return;

    const text = lines
      .map((line) => `${line.timestamp}\n${line.speaker}\n${line.text}`)
      .join('\n\n');

    this.copying.set(true);
    try {
      await navigator.clipboard.writeText(text);
      this.toast.show('Transcript copied to clipboard.', 'success');
    } catch {
      this.toast.show('Could not copy transcript.', 'error');
    } finally {
      this.copying.set(false);
    }
  }

  protected printTranscript(): void {
    if (!this.available()) return;
    window.print();
  }

  protected formatDuration(seconds: number | undefined | null): string {
    if (seconds == null || !Number.isFinite(seconds)) return '—';
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m ${String(rem).padStart(2, '0')}s`;
  }

  protected speakerClass(speaker: string): string {
    return speaker === 'Candidate' ? 'speaker-candidate' : 'speaker-ai';
  }
}
