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
  InterviewAnswerEntry,
  InterviewEvaluation,
  JdAnalysis,
  ScheduledInterview,
  StructuredInterview,
  interviewQuestionProgressLabel,
} from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';
import { extractApiErrorMessage } from '../../utils/api-error';
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

  protected rescheduleDateTime = '';
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
        this.error.set(extractApiErrorMessage(err, 'Failed to load interview.'));
      },
    });
  }

  private seedRescheduleForm(item: ScheduledInterview): void {
    this.rescheduleDateTime = this.toDateTimeLocal(item.date, item.time);
    this.rescheduleTimezone = item.timezone || 'UTC';
    this.rescheduleDuration = Math.min(item.durationMinutes || 25, 30);
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

  /** Prefer /candidate-interview/:id for displayed meeting links. */
  protected candidateMeetingHref(item: ScheduledInterview): string | null {
    const raw = this.safeMeetingHref(item.meetingLink);
    if (raw) {
      return raw.replace(/\/interviews\/([^/?#]+)/, '/candidate-interview/$1');
    }
    if (typeof window !== 'undefined' && item.id) {
      return `${window.location.origin}/candidate-interview/${item.id}`;
    }
    return null;
  }

  protected candidateAnswers(item: ScheduledInterview): InterviewAnswerEntry[] {
    const answers = item.interviewDetails?.answers;
    return Array.isArray(answers) ? answers : [];
  }

  protected hasCandidateAnswers(item: ScheduledInterview): boolean {
    return this.candidateAnswers(item).length > 0;
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
    return item.recordingStatus === 'available' || !!item.recordingPath;
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
        this.toast.show(extractApiErrorMessage(err, 'Evaluation failed.'), 'error');
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

  protected canExtendLink(item: ScheduledInterview): boolean {
    if (item.canExtendLink === false) return false;
    if (item.linkExpired) return false;
    if (!this.canAct(item)) return false;
    const expiresAt = item.expiresAt;
    if (!expiresAt) return false;
    const parsed = new Date(expiresAt).getTime();
    if (Number.isNaN(parsed)) return false;
    return Date.now() <= parsed;
  }

  protected extendLink(): void {
    const current = this.interview();
    if (!current || !this.canExtendLink(current)) return;
    this.actionLoading.set(true);
    this.interviewService.extendInterviewLink(current.id).subscribe({
      next: (result) => {
        this.actionLoading.set(false);
        if (result.interview) {
          this.interview.set(result.interview);
        }
        this.toast.show('Interview link extended by 24 hours.', 'success');
      },
      error: (err: HttpErrorResponse) => {
        this.actionLoading.set(false);
        this.toast.show(extractApiErrorMessage(err, 'Cannot extend an expired link'), 'error');
      },
    });
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

  protected questionProgress(item: ScheduledInterview): string {
    return interviewQuestionProgressLabel(item);
  }

  protected openReschedule(): void {
    const current = this.interview();
    if (current) this.seedRescheduleForm(current);
    this.showReschedule.set(true);
  }

  protected submitReschedule(): void {
    const current = this.interview();
    if (!current) return;
    const { date, time } = this.splitDateTime(this.rescheduleDateTime);
    if (!date || !time) {
      this.toast.show('Date and time are required.', 'error');
      return;
    }

    this.actionLoading.set(true);
    this.interviewService
      .rescheduleInterview(current.id, {
        date,
        time,
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
          if (result.email && !(result.email.sent || result.email.success)) {
            this.toast.show(
              'Interview scheduled successfully, but the candidate invitation email could not be sent. Please verify the candidate email address or email configuration.',
              'error'
            );
          } else {
            this.toast.show('Interview rescheduled. Reminders updated.', 'success');
          }
        },
        error: (err: HttpErrorResponse) => {
          this.actionLoading.set(false);
          this.toast.show(extractApiErrorMessage(err, 'Failed to reschedule.'), 'error');
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
        this.toast.show(extractApiErrorMessage(err, 'Failed to cancel.'), 'error');
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

  private toDateTimeLocal(date: string | null | undefined, time: string | null | undefined): string {
    const datePart = (date || '').trim();
    const timePart = (time || '').trim().slice(0, 5);
    if (!datePart || !timePart) return '';
    return `${datePart}T${timePart}`;
  }

  private splitDateTime(value: string): { date: string; time: string } {
    const raw = (value || '').trim();
    const [datePart, timePart] = raw.split('T');
    return {
      date: (datePart || '').trim(),
      time: (timePart || '').trim().slice(0, 5),
    };
  }
}
