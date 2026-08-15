import {
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { InterviewService } from '../../services/interview';
import { CandidateInterviewQuestion, InterviewTokenResult } from '../../models';
import { extractApiErrorMessage } from '../../utils/api-error';

type ConnectionStatus = 'Idle' | 'Connecting' | 'Live' | 'Completed' | 'Error';
type RecruiterJoinAs = 'interviewer' | 'spectator';

@Component({
  selector: 'app-recruiter-interview',
  standalone: true,
  imports: [CommonModule, RouterLink],
  templateUrl: './recruiter-interview.html',
  styleUrl: './recruiter-interview.css',
})
export class RecruiterInterviewComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly interviewService = inject(InterviewService);
  private readonly platformId = inject(PLATFORM_ID);

  private tokenSub: Subscription | null = null;
  private hmsUnsubscribers: Array<() => void> = [];
  private hmsActions: any = null;
  private hmsStore: any = null;
  protected interviewId = '';

  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly connectionStatus = signal<ConnectionStatus>('Idle');
  protected readonly micEnabled = signal(true);
  protected readonly candidateName = signal('Candidate');
  protected readonly jobRole = signal('');
  protected readonly questions = signal<CandidateInterviewQuestion[]>([]);
  protected readonly joinAs = signal<RecruiterJoinAs>('interviewer');
  protected readonly joinedRole = signal<string | null>(null);

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    this.interviewId = this.route.snapshot.paramMap.get('id') || '';
    if (!this.interviewId) {
      this.error.set('Interview ID is missing.');
      this.connectionStatus.set('Error');
    }
  }

  ngOnDestroy(): void {
    this.tokenSub?.unsubscribe();
    void this.leaveRoom();
  }

  protected selectJoinAs(role: RecruiterJoinAs): void {
    if (this.connectionStatus() === 'Live' || this.loading()) return;
    this.joinAs.set(role);
  }

  protected startJoin(): void {
    if (!this.interviewId || this.loading() || this.connectionStatus() === 'Live') return;
    this.loading.set(true);
    this.error.set(null);
    this.connectionStatus.set('Connecting');

    this.tokenSub?.unsubscribe();
    this.tokenSub = this.interviewService
      .getRecruiterToken(this.interviewId, this.joinAs())
      .subscribe({
        next: (result) => {
          void this.onTokenLoaded(result);
        },
        error: (err: HttpErrorResponse) => {
          this.loading.set(false);
          this.connectionStatus.set('Error');
          this.error.set(this.friendlyJoinError(err));
        },
      });
  }

  protected toggleMic(): void {
    const nextEnabled = !this.micEnabled();
    this.micEnabled.set(nextEnabled);
    if (this.hmsActions?.setLocalAudioEnabled) {
      void Promise.resolve(this.hmsActions.setLocalAudioEnabled(nextEnabled)).catch(() => {
        this.error.set('Could not change the microphone. Check browser permissions.');
      });
    }
  }

  protected async leaveCall(): Promise<void> {
    await this.leaveRoom();
    this.connectionStatus.set('Completed');
  }

  private async onTokenLoaded(result: InterviewTokenResult): Promise<void> {
    this.candidateName.set(result.interview?.candidateName || result.candidateName || 'Candidate');
    this.jobRole.set(result.interview?.jobRole || '');
    this.questions.set(Array.isArray(result.questions) ? result.questions : result.interview?.questions || []);
    this.joinedRole.set(result.role || this.joinAs());

    if (!result.token) {
      this.loading.set(false);
      this.connectionStatus.set('Error');
      this.error.set(
        result.hmsError ||
          'The live interview room is unavailable. Check 100ms configuration and try again.'
      );
      return;
    }

    try {
      await this.joinHmsRoom(result.token, result.interview?.candidateName || 'Interviewer');
      this.loading.set(false);
      this.connectionStatus.set('Live');
    } catch (err) {
      this.loading.set(false);
      this.connectionStatus.set('Error');
      this.error.set(this.friendlyRoomError(err));
    }
  }

  private async joinHmsRoom(authToken: string, userName: string): Promise<void> {
    const { HMSReactiveStore, selectIsConnectedToRoom } = await import(
      '@100mslive/hms-video-store'
    );

    const manager = new HMSReactiveStore();
    manager.triggerOnSubscribe();
    this.hmsStore = manager.getStore();
    this.hmsActions =
      typeof manager.getActions === 'function' ? manager.getActions() : manager.getHMSActions();

    const unsubConnected = this.hmsStore.subscribe((connected: boolean) => {
      if (connected) this.connectionStatus.set('Live');
    }, selectIsConnectedToRoom);
    this.hmsUnsubscribers.push(unsubConnected);

    await this.hmsActions.join({
      userName: userName || 'Interviewer',
      authToken,
      settings: {
        isAudioMuted: !this.micEnabled(),
        isVideoMuted: true,
      },
      rememberDeviceSelection: true,
    });

    try {
      await this.hmsActions.setLocalAudioEnabled(this.micEnabled());
    } catch {
      // local mute already applied
    }
  }

  private async leaveRoom(): Promise<void> {
    try {
      if (this.hmsActions) {
        await this.hmsActions.leave();
      }
    } catch {
      // ignore leave errors
    }
    for (const unsub of this.hmsUnsubscribers) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.hmsUnsubscribers = [];
    this.hmsActions = null;
    this.hmsStore = null;
  }

  private friendlyJoinError(err: HttpErrorResponse): string {
    if (err.status === 403) {
      return extractApiErrorMessage(err, 'This interview cannot be joined.');
    }
    if (err.status === 404) {
      return 'Interview not found.';
    }
    if (err.status === 401) {
      return 'Recruiter authorization failed. Check the API key configuration.';
    }
    if (err.status === 503) {
      return extractApiErrorMessage(err, 'The live interview room is unavailable right now.');
    }
    return extractApiErrorMessage(err, 'Could not start the interview. Please try again.');
  }

  private friendlyRoomError(err: unknown): string {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message || '')
        : '';
    if (/not-allowed|permission|denied/i.test(message)) {
      return 'Microphone permission was blocked. Allow the microphone and try again.';
    }
    if (/expired|invalid token|401/i.test(message)) {
      return 'The interview token expired or is invalid. Click Join Interview again.';
    }
    if (/invalid id|room/i.test(message)) {
      return 'The interview room is unavailable. Confirm the interview is still scheduled.';
    }
    if (/network|offline|failed to fetch/i.test(message)) {
      return 'Network interruption. Check your connection and try joining again.';
    }
    return message && message.length < 180
      ? message
      : 'Could not connect to the live interview room.';
  }
}
