import { Component, OnDestroy, OnInit, PLATFORM_ID, inject, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import {
  Analysis,
  COMMON_TIMEZONES,
  InterviewEvaluation,
  JdAnalysis,
  ScheduledInterview,
  StructuredInterview,
} from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';
import { InterviewQuestionsCard } from '../../components/interview-questions-card/interview-questions-card';
import { PodcastTranscriptCard } from '../../components/podcast-transcript-card/podcast-transcript-card';
import { InterviewEvaluationCard } from '../../components/interview-evaluation-card/interview-evaluation-card';
import { InterviewResultCard } from '../../components/interview-result-card/interview-result-card';

const POST_COMPLETION_STATUSES = new Set([
  'Completed',
  'Transcript Generated',
  'Evaluation Generated',
  'Result Generated',
]);

@Component({
  selector: 'app-interview-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    InterviewQuestionsCard,
    PodcastTranscriptCard,
    InterviewEvaluationCard,
    InterviewResultCard,
  ],
  templateUrl: './interview-detail.html',
  styleUrl: './interview-detail.css',
})
export class InterviewDetail implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly interviewService = inject(InterviewService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);
  private routeSub: Subscription | null = null;
  private loadSub: Subscription | null = null;

  protected readonly interview = signal<ScheduledInterview | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly actionLoading = signal(false);
  protected readonly evalRetryLoading = signal(false);
  protected readonly showReschedule = signal(false);
  protected readonly highlightJoin = signal(false);
  protected readonly timezones = [...COMMON_TIMEZONES];

  protected rescheduleDate = '';
  protected rescheduleTime = '';
  protected rescheduleTimezone = 'UTC';
  protected rescheduleDuration = 25;

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.highlightJoin.set(this.route.snapshot.queryParamMap.get('join') === '1');
    this.routeSub = this.route.paramMap
      .pipe(
        map((params) => params.get('id')),
        distinctUntilChanged()
      )
      .subscribe((id) => {
        if (!id) {
          this.error.set('Interview ID is missing.');
          this.interview.set(null);
          return;
        }
        this.load(id);
      });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.loadSub?.unsubscribe();
  }

  private load(id: string): void {
    this.loadSub?.unsubscribe();
    this.loading.set(true);
    this.error.set(null);
    this.loadSub = this.interviewService.getInterview(id).subscribe({
      next: (result) => {
        this.loading.set(false);
        if (result?.success && result.interview) {
          this.interview.set(result.interview);
          this.seedRescheduleForm(result.interview);
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

  private seedRescheduleForm(item: ScheduledInterview): void {
    this.rescheduleDate = item.date || '';
    this.rescheduleTime = item.time || '';
    this.rescheduleTimezone = item.timezone || 'UTC';
    this.rescheduleDuration = item.durationMinutes || 25;
    if (!this.timezones.includes(this.rescheduleTimezone)) {
      this.timezones.unshift(this.rescheduleTimezone);
    }
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

  protected transcriptDownloadHref(id: string, format: 'txt' | 'pdf'): string {
    return this.interviewService.transcriptDownloadUrl(id, format);
  }

  protected recordingDownloadHref(id: string): string {
    return this.interviewService.recordingDownloadUrl(id);
  }

  protected evaluationDownloadHref(id: string): string {
    return this.interviewService.evaluationDownloadUrl(id, 'pdf');
  }

  protected resultReportDownloadHref(id: string): string {
    return this.interviewService.resultReportDownloadUrl(id, 'pdf');
  }

  protected excelDownloadHref(id: string): string {
    return this.interviewService.excelSummaryDownloadUrl(id);
  }

  protected hasRecording(item: ScheduledInterview): boolean {
    return !!item.recordingPath;
  }

  protected hasTranscript(item: ScheduledInterview): boolean {
    return !!(item.transcriptId || item.transcriptPath);
  }

  protected hasExcel(item: ScheduledInterview): boolean {
    return !!(item.evaluation || item.excelSummaryPath || item.excelSummaryUrl);
  }

  protected scrollToId(elementId: string): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const el = document.getElementById(elementId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  protected async shareResultReport(item: ScheduledInterview): Promise<void> {
    const url = this.resultReportDownloadHref(item.id);
    const title = `Hiring Result — ${item.candidateName}`;
    const text = `Final interview result for ${item.candidateName} (${this.jobRole(item)}): ${item.result || 'Pending'}`;

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title, text, url });
        this.toast.show('Report share sheet opened.', 'success');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        this.toast.show('Result report link copied to clipboard.', 'success');
        return;
      }
      this.toast.show('Copy this link: ' + url, 'success');
    } catch {
      this.toast.show('Unable to share report.', 'error');
    }
  }

  protected canRetryEvaluation(item: ScheduledInterview): boolean {
    const status = item.transcriptMeta?.evaluationStatus;
    return (
      this.isCompleted(item) &&
      !!item.transcriptId &&
      !item.evaluation &&
      (status === 'Failed' || status === 'Pending' || item.status === 'Transcript Generated')
    );
  }

  protected retryEvaluation(): void {
    const current = this.interview();
    if (!current) return;

    this.evalRetryLoading.set(true);
    this.interviewService.reEvaluateInterview(current.id).subscribe({
      next: (result) => {
        this.evalRetryLoading.set(false);
        if (result.interview) {
          this.interview.set(result.interview);
        }
        this.toast.show('AI Evaluation generated from the podcast transcript.', 'success');
      },
      error: (err: HttpErrorResponse) => {
        this.evalRetryLoading.set(false);
        if (err?.error?.interview) {
          this.interview.set(err.error.interview);
        }
        this.toast.show(err?.error?.error || 'Evaluation failed.', 'error');
      },
    });
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

  protected asEvaluation(value: ScheduledInterview['evaluation']): InterviewEvaluation | null {
    if (!value || typeof value !== 'object') return null;
    return value as InterviewEvaluation;
  }

  protected jobRole(item: ScheduledInterview): string {
    if (item.jobRole) return item.jobRole;
    const jd = this.asJd(item.jobDescription);
    if (jd?.jobTitle) return jd.jobTitle;
    const analysis = this.asAnalysis(item.resumeSummary);
    return analysis?.role || analysis?.currentDesignation || '—';
  }

  protected currentCompany(item: ScheduledInterview): string {
    if (item.currentCompany) return item.currentCompany;
    return this.asAnalysis(item.resumeSummary)?.currentCompany || '—';
  }

  protected canAct(item: ScheduledInterview): boolean {
    return (
      item.status === 'Scheduled' ||
      item.status === 'Reminder Sent' ||
      item.status === 'In Progress'
    );
  }

  protected isCompleted(item: ScheduledInterview): boolean {
    return item.isCompleted === true || POST_COMPLETION_STATUSES.has(item.status);
  }

  protected formatDurationMinutes(item: ScheduledInterview): string {
    const metaSec = item.transcriptMeta?.duration;
    if (metaSec != null && Number.isFinite(metaSec)) {
      const m = Math.floor(metaSec / 60);
      const s = Math.round(metaSec % 60);
      return `${m}m ${String(s).padStart(2, '0')}s`;
    }
    return `${item.durationMinutes || 0} minutes (scheduled)`;
  }

  protected openReschedule(): void {
    const current = this.interview();
    if (current) this.seedRescheduleForm(current);
    this.showReschedule.set(true);
  }

  protected submitReschedule(): void {
    const current = this.interview();
    if (!current) return;
    if (!this.rescheduleDate || !this.rescheduleTime) {
      this.toast.show('Date and time are required.', 'error');
      return;
    }

    this.actionLoading.set(true);
    this.interviewService
      .rescheduleInterview(current.id, {
        date: this.rescheduleDate,
        time: this.rescheduleTime,
        duration: this.rescheduleDuration,
        timezone: this.rescheduleTimezone,
      })
      .subscribe({
        next: (result) => {
          this.actionLoading.set(false);
          this.showReschedule.set(false);
          if (result.interview) {
            this.interview.set(result.interview);
          }
          this.toast.show('Interview rescheduled. Reminders updated.', 'success');
        },
        error: (err: HttpErrorResponse) => {
          this.actionLoading.set(false);
          this.toast.show(err?.error?.error || 'Failed to reschedule.', 'error');
        },
      });
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

  protected statusClass(status: string): string {
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
    if (value.includes('expired')) return 'status-expired';
    if (value.includes('draft')) return 'status-draft';
    return 'status-scheduled';
  }

  protected resultClass(result: string | undefined): string {
    const value = (result || 'Pending').toLowerCase();
    if (value === 'selected') return 'result-selected';
    if (value === 'rejected') return 'result-rejected';
    return 'result-pending';
  }

  protected joinStateClass(state: string | undefined): string {
    if (state === 'started') return 'join-started';
    if (state === 'ready') return 'join-ready';
    if (state === 'ended') return 'join-ended';
    return 'join-unavailable';
  }
}
