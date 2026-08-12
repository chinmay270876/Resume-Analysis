import { Component, OnChanges, OnInit, SimpleChanges, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import {
  Analysis,
  COMMON_TIMEZONES,
  CreateInterviewPayload,
  JdAnalysis,
  ScheduledInterview,
  StructuredInterview,
} from '../../models';
import { InterviewService } from '../../services/interview';
import { ToastService } from '../../services/toast';
import { extractApiErrorMessage } from '../../utils/api-error';

@Component({
  selector: 'app-interview-scheduler',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './interview-scheduler.html',
  styleUrl: './interview-scheduler.css',
})
export class InterviewScheduler implements OnInit, OnChanges {
  readonly interview = input<StructuredInterview | null>(null);
  readonly analysis = input<Analysis | null>(null);
  readonly jdAnalysis = input<JdAnalysis | null>(null);
  readonly resumeId = input<string | null>(null);
  /** When false, omits badge/title chrome (parent collapsible section supplies it). */
  readonly showHeader = input(true);

  readonly scheduled = output<ScheduledInterview>();

  private readonly interviewService = inject(InterviewService);
  private readonly toast = inject(ToastService);

  protected readonly timezones = [...COMMON_TIMEZONES];
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly createdInterview = signal<ScheduledInterview | null>(null);

  protected candidateName = '';
  protected candidateEmail = '';
  protected date = '';
  protected time = '';
  protected timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  protected duration = 25;

  ngOnInit(): void {
    this.prefillDuration();
    this.prefillCandidate();
    if (!this.timezones.includes(this.timezone)) {
      this.timezones.unshift(this.timezone);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['interview']) {
      this.prefillDuration();
    }
    if (changes['analysis'] || changes['jdAnalysis']) {
      this.prefillCandidate();
    }
  }

  /** Prefill duration from the interview; leave candidate name/email blank for manual entry. */
  private prefillDuration(): void {
    const interview = this.interview();
    if (interview?.estimatedDuration) {
      const match = String(interview.estimatedDuration).match(/(\d+)/);
      if (match) {
        this.duration = Number(match[1]) || 25;
      }
    }
  }

  /** Prefill candidate fields from resume analysis when available. */
  private prefillCandidate(): void {
    const analysis = this.analysis();
    if (analysis?.candidateName && !this.candidateName.trim()) {
      this.candidateName = analysis.candidateName;
    }
    if (analysis?.email && !this.candidateEmail.trim()) {
      this.candidateEmail = analysis.email;
    }
  }

  protected submit(): void {
    this.error.set(null);

    if (!this.candidateName.trim() || !this.candidateEmail.trim()) {
      this.error.set('Candidate name and email are required.');
      return;
    }
    if (!this.date || !this.time) {
      this.error.set('Date and time are required.');
      return;
    }

    const analysis = this.analysis();
    const jd = this.jdAnalysis();

    const payload: CreateInterviewPayload = {
      candidateName: this.candidateName.trim(),
      candidateEmail: this.candidateEmail.trim(),
      date: this.date,
      time: this.time,
      timezone: this.timezone,
      duration: this.duration,
      status: 'Scheduled',
      resumeId: this.resumeId(),
      jobRole: jd?.jobTitle || analysis?.role || analysis?.currentDesignation || null,
      currentCompany: analysis?.currentCompany || null,
      interviewer: 'Voice AI Agent',
      interview: this.interview(),
      interviewJson: this.interview(),
      analysis: analysis,
      resumeSummary: analysis,
      jdAnalysis: jd,
      jobDescription: jd,
    };

    this.submitting.set(true);
    this.interviewService.createInterview(payload).subscribe({
      next: (result) => {
        this.submitting.set(false);
        if (result?.success && result.interview) {
          this.createdInterview.set(result.interview);
          this.scheduled.emit(result.interview);
          const emailNote =
            result.email?.success
              ? ' Invitation email sent.'
              : result.email?.skipped
                ? ' Invitation email skipped (invalid email).'
                : result.email?.error
                  ? ` Interview saved; email failed: ${result.email.error}`
                  : '';
          this.toast.show(`Interview scheduled.${emailNote}`, 'success');
        } else {
          this.error.set(result?.error || result?.message || 'Failed to schedule interview.');
        }
      },
      error: (err: HttpErrorResponse) => {
        this.submitting.set(false);
        this.error.set(extractApiErrorMessage(err, 'Failed to schedule interview.'));
      },
    });
  }
}
