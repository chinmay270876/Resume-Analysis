import { Component, OnInit, PLATFORM_ID, inject, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { InterviewListFilter, ScheduledInterview } from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';

type DashboardTab = InterviewListFilter;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard implements OnInit {
  private readonly interviewService = inject(InterviewService);
  private readonly toast = inject(ToastService);
  private readonly platformId = inject(PLATFORM_ID);

  protected readonly tabs: { id: DashboardTab; label: string }[] = [
    { id: 'upcoming', label: "Upcoming Interviews" },
    { id: 'today', label: "Today's Interviews" },
    { id: 'completed', label: 'Completed Interviews' },
    { id: 'cancelled', label: 'Cancelled Interviews' },
  ];

  protected readonly activeTab = signal<DashboardTab>('upcoming');
  protected readonly interviews = signal<ScheduledInterview[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly actionId = signal<string | null>(null);

  ngOnInit(): void {
    if (isPlatformBrowser(this.platformId)) {
      this.loadInterviews();
    }
  }

  protected selectTab(tab: DashboardTab): void {
    this.activeTab.set(tab);
    this.loadInterviews();
  }

  protected loadInterviews(): void {
    this.loading.set(true);
    this.error.set(null);

    this.interviewService.listInterviews({ filter: this.activeTab() }).subscribe({
      next: (result) => {
        this.loading.set(false);
        this.interviews.set(result.interviews || []);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        const message = err?.error?.error || err?.message || 'Failed to load interviews.';
        this.error.set(message);
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
        this.loadInterviews();
      },
      error: (err: HttpErrorResponse) => {
        this.actionId.set(null);
        this.toast.show(err?.error?.error || 'Failed to cancel interview.', 'error');
      },
    });
  }

  protected completeInterview(interview: ScheduledInterview): void {
    this.actionId.set(interview.id);
    this.interviewService.completeInterview(interview.id).subscribe({
      next: () => {
        this.actionId.set(null);
        this.toast.show('Interview marked completed.', 'success');
        this.loadInterviews();
      },
      error: (err: HttpErrorResponse) => {
        this.actionId.set(null);
        this.toast.show(err?.error?.error || 'Failed to update interview.', 'error');
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

  protected trackById(_index: number, item: ScheduledInterview): string {
    return item.id;
  }
}
