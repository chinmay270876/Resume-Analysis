import { Component, OnDestroy, OnInit, PLATFORM_ID, inject, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import {
  InterviewCompareCandidate,
  InterviewListFilter,
  InterviewRankedCandidate,
  InterviewSortBy,
  InterviewSortDir,
  InterviewStats,
  ScheduledInterview,
  interviewQuestionProgressLabel,
} from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';
import { extractApiErrorMessage } from '../../utils/api-error';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard implements OnInit, OnDestroy {
  private readonly interviewService = inject(InterviewService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  protected readonly filters: { id: InterviewListFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'scheduled', label: 'Scheduled' },
    { id: 'completed', label: 'Completed' },
    { id: 'pending', label: 'Pending' },
    { id: 'selected', label: 'Selected' },
    { id: 'rejected', label: 'Rejected' },
    { id: 'cancelled', label: 'Cancelled' },
    { id: 'reminder sent', label: 'Reminder Sent' },
    { id: 'in progress', label: 'In Progress' },
  ];

  protected readonly sortOptions: { id: InterviewSortBy; label: string }[] = [
    { id: 'date', label: 'Interview Date' },
    { id: 'name', label: 'Candidate Name' },
    { id: 'score', label: 'Overall Score' },
    { id: 'jdMatch', label: 'JD Match' },
    { id: 'technical', label: 'Technical Score' },
    { id: 'result', label: 'Result' },
    { id: 'status', label: 'Status' },
  ];

  protected readonly activeFilter = signal<InterviewListFilter>('all');
  protected readonly searchQuery = signal('');
  protected readonly sortBy = signal<InterviewSortBy>('date');
  protected readonly sortDir = signal<InterviewSortDir>('asc');
  protected readonly page = signal(1);
  protected readonly pageSize = 8;
  protected readonly totalPages = signal(1);
  protected readonly totalCount = signal(0);

  protected readonly interviews = signal<ScheduledInterview[]>([]);
  protected readonly stats = signal<InterviewStats | null>(null);
  protected readonly rankings = signal<InterviewRankedCandidate[]>([]);
  protected readonly compareSelection = signal<string[]>([]);
  protected readonly compareRows = signal<InterviewCompareCandidate[]>([]);
  protected readonly showCompare = signal(false);
  protected readonly loading = signal(false);
  protected readonly rankingLoading = signal(false);
  protected readonly compareLoading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly actionId = signal<string | null>(null);

  /** Inline reschedule form state */
  protected readonly rescheduleId = signal<string | null>(null);
  protected rescheduleDateTime = '';
  protected rescheduleDuration = 25;

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.loadStats();
      this.loadInterviews();
      this.loadRanking();
    }
  }

  ngOnDestroy(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
  }

  protected selectFilter(filter: InterviewListFilter): void {
    this.activeFilter.set(filter);
    this.page.set(1);
    this.loadInterviews();
  }

  protected onSearchInput(value: string): void {
    this.searchQuery.set(value);
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.page.set(1);
      this.loadInterviews();
    }, 300);
  }

  protected onSortChange(sortBy: InterviewSortBy): void {
    this.sortBy.set(sortBy);
    this.page.set(1);
    this.loadInterviews();
  }

  protected toggleSortDir(): void {
    this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    this.loadInterviews();
  }

  protected goToPage(page: number): void {
    const next = Math.min(Math.max(page, 1), this.totalPages());
    if (next === this.page()) return;
    this.page.set(next);
    this.loadInterviews();
  }

  protected refreshAll(): void {
    this.loadStats();
    this.loadInterviews();
    this.loadRanking();
  }

  protected loadStats(): void {
    this.interviewService.getInterviewStats().subscribe({
      next: (result) => {
        if (result?.stats) {
          this.stats.set(result.stats);
        }
      },
      error: () => {
        // Non-blocking — list can still load without summary strip.
      },
    });
  }

  protected loadRanking(): void {
    this.rankingLoading.set(true);
    this.interviewService.getCandidateRanking(20).subscribe({
      next: (result) => {
        this.rankingLoading.set(false);
        this.rankings.set(result.rankings || []);
      },
      error: () => {
        this.rankingLoading.set(false);
        this.rankings.set([]);
      },
    });
  }

  protected loadInterviews(): void {
    this.loading.set(true);
    this.error.set(null);

    this.interviewService
      .listInterviews({
        filter: this.activeFilter(),
        search: this.searchQuery().trim() || undefined,
        sortBy: this.sortBy(),
        sortDir: this.sortDir(),
        page: this.page(),
        pageSize: this.pageSize,
      })
      .subscribe({
        next: (result) => {
          this.loading.set(false);
          this.interviews.set(result.interviews || []);
          this.totalCount.set(result.count ?? result.interviews?.length ?? 0);
          this.totalPages.set(result.totalPages ?? 1);
          if (result.page) {
            this.page.set(result.page);
          }
        },
        error: (err: HttpErrorResponse) => {
          this.loading.set(false);
          const message = extractApiErrorMessage(err, 'Failed to load interviews.');
          this.error.set(message);
        },
      });
  }

  protected isSelectedForCompare(id: string): boolean {
    return this.compareSelection().includes(id);
  }

  protected toggleCompare(id: string): void {
    const current = this.compareSelection();
    if (current.includes(id)) {
      this.compareSelection.set(current.filter((x) => x !== id));
      return;
    }
    if (current.length >= 5) {
      this.toast.show('Compare supports up to 5 candidates.', 'error');
      return;
    }
    this.compareSelection.set([...current, id]);
  }

  protected openCompare(): void {
    const ids = this.compareSelection();
    if (ids.length < 2) {
      this.toast.show('Select at least two candidates to compare.', 'error');
      return;
    }
    this.compareLoading.set(true);
    this.interviewService.compareCandidates(ids).subscribe({
      next: (result) => {
        this.compareLoading.set(false);
        this.compareRows.set(result.candidates || []);
        this.showCompare.set(true);
      },
      error: (err: HttpErrorResponse) => {
        this.compareLoading.set(false);
        this.toast.show(extractApiErrorMessage(err, 'Failed to compare candidates.'), 'error');
      },
    });
  }

  protected closeCompare(): void {
    this.showCompare.set(false);
  }

  protected clearCompareSelection(): void {
    this.compareSelection.set([]);
    this.showCompare.set(false);
    this.compareRows.set([]);
  }

  protected jobRole(interview: ScheduledInterview): string {
    if (interview.jobRole) return interview.jobRole;
    const jd = interview.jobDescription as { jobTitle?: string } | null;
    if (jd?.jobTitle) return jd.jobTitle;
    const resume = interview.resumeSummary as { role?: string; currentDesignation?: string } | null;
    return resume?.role || resume?.currentDesignation || '—';
  }

  protected currentCompany(interview: ScheduledInterview): string {
    if (interview.currentCompany) return interview.currentCompany;
    const resume = interview.resumeSummary as { currentCompany?: string } | null;
    return resume?.currentCompany || '—';
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

  protected formatDuration(interview: ScheduledInterview): string {
    const metaSec = interview.transcriptMeta?.duration;
    if (metaSec != null && Number.isFinite(metaSec)) {
      const m = Math.floor(metaSec / 60);
      const s = Math.round(metaSec % 60);
      return `${m}m ${String(s).padStart(2, '0')}s`;
    }
    return `${interview.durationMinutes} Minutes`;
  }

  protected questionProgress(interview: ScheduledInterview): string {
    return interviewQuestionProgressLabel(interview);
  }

  protected formatAvg(value: number | null | undefined, suffix = ''): string {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${value}${suffix}`;
  }

  protected scoreOf(
    nested: { score?: number | null } | number | null | undefined,
    flat: number | null | undefined
  ): number | null {
    if (nested && typeof nested === 'object' && nested.score != null) return nested.score;
    if (typeof nested === 'number') return nested;
    if (flat != null) return flat;
    return null;
  }

  protected listPreview(items: string[] | undefined, max = 3): string {
    if (!Array.isArray(items) || items.length === 0) return '—';
    const shown = items.slice(0, max);
    return items.length > max ? `${shown.join('; ')}…` : shown.join('; ');
  }

  protected formatExpiresAt(value: string | null | undefined): string {
    if (!value) return '—';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  protected canAct(interview: ScheduledInterview): boolean {
    return (
      interview.status === 'Scheduled' ||
      interview.status === 'Reminder Sent' ||
      interview.status === 'In Progress'
    );
  }

  protected canExtendLink(interview: ScheduledInterview): boolean {
    if (interview.canExtendLink === false) return false;
    if (interview.linkExpired) return false;
    if (!this.canAct(interview)) return false;
    const expiresAt = interview.expiresAt;
    if (!expiresAt) return false;
    const parsed = new Date(expiresAt).getTime();
    if (Number.isNaN(parsed)) return false;
    return Date.now() <= parsed;
  }

  protected extendLink(interview: ScheduledInterview): void {
    if (!this.canExtendLink(interview)) return;
    this.actionId.set(interview.id);
    this.interviewService.extendInterviewLink(interview.id).subscribe({
      next: () => {
        this.actionId.set(null);
        this.toast.show('Interview link extended by 24 hours.', 'success');
        this.refreshAll();
      },
      error: (err: HttpErrorResponse) => {
        this.actionId.set(null);
        this.toast.show(extractApiErrorMessage(err, 'Cannot extend an expired link'), 'error');
        this.refreshAll();
      },
    });
  }

  protected openReschedule(interview: ScheduledInterview): void {
    this.rescheduleId.set(interview.id);
    this.rescheduleDateTime = this.toDateTimeLocal(interview.date, interview.time);
    this.rescheduleDuration = Math.min(interview.durationMinutes || 25, 30);
  }

  protected closeReschedule(): void {
    this.rescheduleId.set(null);
  }

  protected submitReschedule(interview: ScheduledInterview): void {
    const { date, time } = this.splitDateTime(this.rescheduleDateTime);
    if (!date || !time) {
      this.toast.show('Date and time are required.', 'error');
      return;
    }
    this.actionId.set(interview.id);
    this.interviewService
      .rescheduleInterview(interview.id, {
        date,
        time,
        duration: this.rescheduleDuration,
        timezone: interview.timezone,
      })
      .subscribe({
        next: () => {
          this.actionId.set(null);
          this.rescheduleId.set(null);
          this.toast.show('Interview rescheduled. Reminders updated.', 'success');
          this.refreshAll();
        },
        error: (err: HttpErrorResponse) => {
          this.actionId.set(null);
          this.toast.show(extractApiErrorMessage(err, 'Failed to reschedule.'), 'error');
        },
      });
  }

  protected cancelInterview(interview: ScheduledInterview): void {
    if (!confirm(`Cancel interview with ${interview.candidateName}?`)) {
      return;
    }
    this.actionId.set(interview.id);
    this.interviewService.cancelInterview(interview.id).subscribe({
      next: () => {
        this.actionId.set(null);
        this.toast.show('Interview cancelled.', 'success');
        this.refreshAll();
      },
      error: (err: HttpErrorResponse) => {
        this.actionId.set(null);
        this.toast.show(extractApiErrorMessage(err, 'Failed to cancel interview.'), 'error');
      },
    });
  }

  protected isPostCompletion(status: string | undefined): boolean {
    const value = status || '';
    return (
      value === 'Completed' ||
      value === 'Transcript Generated' ||
      value === 'Evaluation Generated' ||
      value === 'Result Generated'
    );
  }

  protected hasFinalResult(interview: ScheduledInterview): boolean {
    return (
      interview.status === 'Result Generated' ||
      interview.result === 'Selected' ||
      interview.result === 'Rejected'
    );
  }

  protected hasTranscript(interview: ScheduledInterview): boolean {
    return !!(interview.transcriptId || interview.transcriptPath);
  }

  protected hasRecording(interview: ScheduledInterview): boolean {
    return !!interview.recordingPath;
  }

  protected hasEvaluation(interview: ScheduledInterview): boolean {
    return !!interview.evaluation;
  }

  protected hasExcel(interview: ScheduledInterview): boolean {
    return !!(interview.evaluation || interview.excelSummaryPath || interview.excelSummaryUrl);
  }

  protected transcriptDownloadHref(id: string): string {
    return this.interviewService.transcriptDownloadUrl(id, 'pdf');
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

  protected async shareReport(interview: ScheduledInterview): Promise<void> {
    const url = this.resultReportDownloadHref(interview.id);
    const title = `Hiring Result — ${interview.candidateName}`;
    const text = `Final interview result for ${interview.candidateName}: ${interview.result || 'Pending'}`;
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

  protected resultDisplay(result: string | undefined): string {
    const value = result || 'Pending';
    if (value === 'Selected') return 'Selected';
    if (value === 'Rejected') return 'Rejected';
    return 'Pending';
  }

  protected trackById(_index: number, item: ScheduledInterview): string {
    return item.id;
  }

  protected trackByRank(_index: number, item: InterviewRankedCandidate): string {
    return item.interviewId;
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
