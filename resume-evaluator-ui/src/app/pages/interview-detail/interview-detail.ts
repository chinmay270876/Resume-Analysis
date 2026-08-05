import { Component, OnInit, PLATFORM_ID, inject, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Analysis,
  JdAnalysis,
  ScheduledInterview,
  StructuredInterview,
} from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';
import { InterviewQuestionsCard } from '../../components/interview-questions-card/interview-questions-card';

@Component({
  selector: 'app-interview-detail',
  standalone: true,
  imports: [CommonModule, RouterLink, InterviewQuestionsCard],
  templateUrl: './interview-detail.html',
  styleUrl: './interview-detail.css',
})
export class InterviewDetail implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly interviewService = inject(InterviewService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);

  protected readonly interview = signal<ScheduledInterview | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly actionLoading = signal(false);

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      const id = this.route.snapshot.paramMap.get('id');
      if (!id) {
        this.error.set('Interview ID is missing.');
        return;
      }
      this.load(id);
    }
  }

  private load(id: string): void {
    this.loading.set(true);
    this.error.set(null);
    this.interviewService.getInterview(id).subscribe({
      next: (result) => {
        this.loading.set(false);
        if (result?.success && result.interview) {
          this.interview.set(result.interview);
        } else {
          this.error.set(result?.error || result?.message || 'Interview not found.');
        }
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(err?.error?.error || err?.message || 'Failed to load interview.');
      },
    });
  }

  /** Only allow http(s) meeting links in the template href. */
  protected safeMeetingHref(link: string | null | undefined): string | null {
    if (!link || typeof link !== 'string') {
      return null;
    }
    try {
      const parsed = new URL(link);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return link;
      }
    } catch {
      // invalid URL
    }
    return null;
  }

  protected asAnalysis(value: ScheduledInterview['resumeSummary']): Analysis | null {
    if (!value || typeof value !== 'object') return null;
    return value as Analysis;
  }

  protected asJd(value: ScheduledInterview['jobDescription']): JdAnalysis | null {
    if (!value || typeof value !== 'object') return null;
    return value as JdAnalysis;
  }

  protected asStructuredInterview(
    value: ScheduledInterview['interviewJson']
  ): StructuredInterview | null {
    if (!value || typeof value !== 'object') return null;
    const maybe = value as StructuredInterview;
    if (!Array.isArray(maybe.sections)) return null;
    return maybe;
  }

  protected cancel(): void {
    const current = this.interview();
    if (!current) return;
    if (!confirm(`Cancel interview with ${current.candidateName}?`)) return;

    this.actionLoading.set(true);
    this.interviewService.cancelInterview(current.id).subscribe({
      next: (result) => {
        this.actionLoading.set(false);
        if (result.interview) {
          this.interview.set(result.interview);
        }
        this.toast.show('Interview cancelled.', 'success');
      },
      error: (err: HttpErrorResponse) => {
        this.actionLoading.set(false);
        this.toast.show(err?.error?.error || 'Failed to cancel.', 'error');
      },
    });
  }

  protected complete(): void {
    const current = this.interview();
    if (!current) return;

    this.actionLoading.set(true);
    this.interviewService.completeInterview(current.id).subscribe({
      next: (result) => {
        this.actionLoading.set(false);
        if (result.interview) {
          this.interview.set(result.interview);
        }
        this.toast.show('Interview marked completed.', 'success');
      },
      error: (err: HttpErrorResponse) => {
        this.actionLoading.set(false);
        this.toast.show(err?.error?.error || 'Failed to update.', 'error');
      },
    });
  }

  protected statusClass(status: string): string {
    const value = (status || '').toLowerCase();
    if (value.includes('cancel')) return 'status-cancelled';
    if (value.includes('complete')) return 'status-completed';
    if (value.includes('progress')) return 'status-progress';
    if (value.includes('reminder')) return 'status-reminder';
    if (value.includes('expired')) return 'status-expired';
    if (value.includes('draft')) return 'status-draft';
    return 'status-scheduled';
  }
}
