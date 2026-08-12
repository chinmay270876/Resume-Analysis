import {
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  inject,
  signal,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { HttpErrorResponse } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';
import { InterviewService } from '../../services/interview';
import { extractApiErrorMessage } from '../../utils/api-error';
import {
  CandidateInterviewQuestion,
  CandidateInterviewSession,
  InterviewAnswerEntry,
} from '../../models';

type ConnectionStatus = 'Connecting' | 'Live' | 'Completed' | 'Error';

@Component({
  selector: 'app-candidate-interview',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './candidate-interview.html',
  styleUrl: './candidate-interview.css',
})
export class CandidateInterviewComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly interviewService = inject(InterviewService);
  private readonly title = inject(Title);
  private readonly platformId = inject(PLATFORM_ID);

  private routeSub: Subscription | null = null;
  private tokenSub: Subscription | null = null;
  private hmsUnsubscribers: Array<() => void> = [];
  private hmsActions: any = null;
  private hmsStore: any = null;
  private recognition: any = null;
  private answerStartedAt = 0;
  private interviewId = '';

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly connectionStatus = signal<ConnectionStatus>('Connecting');
  protected readonly micEnabled = signal(true);
  protected readonly audioLevel = signal(0);
  protected readonly waveformBars = signal<number[]>(Array.from({ length: 12 }, () => 10));
  protected readonly candidateName = signal('Candidate');
  protected readonly questions = signal<CandidateInterviewQuestion[]>([]);
  protected readonly currentIndex = signal(0);
  protected readonly liveTranscript = signal('');
  protected readonly saving = signal(false);
  protected readonly listening = signal(false);
  protected readonly session = signal<CandidateInterviewSession | null>(null);

  ngOnInit(): void {
    this.title.setTitle('Candidate Interview');

    if (!isPlatformBrowser(this.platformId)) {
      this.loading.set(false);
      return;
    }

    this.routeSub = this.route.paramMap
      .pipe(
        map((params) => params.get('id')),
        distinctUntilChanged()
      )
      .subscribe((id) => {
        if (!id) {
          this.loading.set(false);
          this.error.set('Interview ID is missing.');
          return;
        }
        this.interviewId = id;
        void this.bootstrap(id);
      });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.tokenSub?.unsubscribe();
    this.stopSpeechRecognition();
    this.teardownHms();
  }

  protected get currentQuestion(): CandidateInterviewQuestion | null {
    const list = this.questions();
    const idx = this.currentIndex();
    return list[idx] || null;
  }

  protected get questionProgressLabel(): string {
    const total = this.questions().length;
    if (!total) return 'No questions available';
    return `Question ${this.currentIndex() + 1} of ${total}`;
  }

  private updateWaveform(level: number): void {
    const bars = Array.from({ length: 12 }, (_, i) => {
      const wave = Math.sin((level / 100) * Math.PI + i * 0.45);
      return Math.max(
        8,
        Math.round((level * 0.7 + Math.abs(wave) * 30) * (0.4 + (i % 3) * 0.2))
      );
    });
    this.waveformBars.set(bars);
  }

  protected async toggleMic(): Promise<void> {
    if (!this.hmsActions || !this.hmsStore) return;
    try {
      const { selectIsLocalAudioEnabled } = await import('@100mslive/hms-video-store');
      const enabled = !!this.hmsStore.getState(selectIsLocalAudioEnabled);
      await this.hmsActions.setLocalAudioEnabled(!enabled);
      this.micEnabled.set(!enabled);
      if (!enabled) {
        this.startSpeechRecognition();
      } else {
        this.stopSpeechRecognition(false);
      }
    } catch (err) {
      console.error('Mic toggle failed', err);
    }
  }

  protected async submitCurrentAnswer(advance = true): Promise<void> {
    const question = this.currentQuestion;
    if (!question || !this.interviewId) return;

    const transcript = this.liveTranscript().trim();
    const durationSeconds =
      this.answerStartedAt > 0
        ? Math.max(1, Math.round((Date.now() - this.answerStartedAt) / 1000))
        : null;

    const answer: InterviewAnswerEntry = {
      questionNo: question.questionNo,
      question: question.question,
      transcript,
      audioDurationSeconds: durationSeconds,
      answeredAt: new Date().toISOString(),
    };

    this.saving.set(true);
    this.stopSpeechRecognition(false);

    this.interviewService
      .saveInterviewAnswers(this.interviewId, { answers: [answer] })
      .subscribe({
        next: () => {
          this.saving.set(false);
          if (!advance) return;
          const next = this.currentIndex() + 1;
          if (next >= this.questions().length) {
            void this.finishInterview();
          } else {
            this.currentIndex.set(next);
            this.liveTranscript.set('');
            this.answerStartedAt = Date.now();
            this.startSpeechRecognition();
          }
        },
        error: (err: HttpErrorResponse) => {
          this.saving.set(false);
          this.error.set(extractApiErrorMessage(err, 'Failed to save answer.'));
        },
      });
  }

  protected async endCall(): Promise<void> {
    await this.finishInterview();
  }

  private async bootstrap(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.connectionStatus.set('Connecting');
    this.teardownHms();

    this.tokenSub?.unsubscribe();
    this.tokenSub = this.interviewService.getInterviewToken(id).subscribe({
      next: async (result) => {
        try {
          if (!result?.success || !result.token) {
            this.loading.set(false);
            this.error.set(result?.error || 'Unable to join interview room.');
            this.connectionStatus.set('Error');
            return;
          }

          this.candidateName.set(result.candidateName || result.interview?.candidateName || 'Candidate');
          this.session.set(result.interview || null);
          const qs = Array.isArray(result.interview?.questions)
            ? result.interview!.questions
            : [];
          this.questions.set(qs);
          this.currentIndex.set(0);
          this.liveTranscript.set('');
          this.answerStartedAt = Date.now();

          await this.joinHmsRoom(result.token, this.candidateName());
          this.loading.set(false);
          this.startSpeechRecognition();
        } catch (err: any) {
          this.loading.set(false);
          this.connectionStatus.set('Error');
          this.error.set(err?.message || 'Failed to connect to the interview room.');
        }
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.connectionStatus.set('Error');
        this.error.set(extractApiErrorMessage(err, 'Failed to start interview.'));
      },
    });
  }

  private async joinHmsRoom(authToken: string, userName: string): Promise<void> {
    const {
      HMSReactiveStore,
      selectIsConnectedToRoom,
      selectIsLocalAudioEnabled,
      selectLocalPeer,
      selectPeerAudioByID,
    } = await import('@100mslive/hms-video-store');

    const manager = new HMSReactiveStore();
    manager.triggerOnSubscribe();
    this.hmsStore = manager.getStore();
    this.hmsActions =
      typeof manager.getActions === 'function'
        ? manager.getActions()
        : manager.getHMSActions();

    const unsubConnected = this.hmsStore.subscribe((connected: boolean) => {
      if (connected) {
        this.connectionStatus.set('Live');
      }
    }, selectIsConnectedToRoom);

    const unsubMic = this.hmsStore.subscribe((enabled: boolean) => {
      this.micEnabled.set(!!enabled);
    }, selectIsLocalAudioEnabled);

    this.hmsUnsubscribers.push(unsubConnected, unsubMic);

    await this.hmsActions.join({
      userName: userName || 'Candidate',
      authToken,
      settings: {
        isAudioMuted: false,
        isVideoMuted: false,
      },
      rememberDeviceSelection: true,
    });

    const localPeer = this.hmsStore.getState(selectLocalPeer);
    if (localPeer?.id) {
      const unsubLevel = this.hmsStore.subscribe((level: number) => {
        const normalized = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
        this.audioLevel.set(normalized);
        this.updateWaveform(normalized);
      }, selectPeerAudioByID(localPeer.id));
      this.hmsUnsubscribers.push(unsubLevel);
    }

    this.connectionStatus.set('Live');
  }

  private startSpeechRecognition(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      return;
    }

    this.stopSpeechRecognition(false);
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => this.listening.set(true);
    recognition.onend = () => {
      this.listening.set(false);
      if (this.connectionStatus() === 'Live' && this.micEnabled()) {
        try {
          recognition.start();
        } catch {
          // ignore restart races
        }
      }
    };
    recognition.onerror = () => this.listening.set(false);
    recognition.onresult = (event: any) => {
      let interim = '';
      let finalText = this.liveTranscript();
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) {
          finalText = `${finalText} ${text}`.trim();
        } else {
          interim += text;
        }
      }
      this.liveTranscript.set(`${finalText}${interim ? ` ${interim}` : ''}`.trim());
    };

    try {
      recognition.start();
      this.recognition = recognition;
    } catch (err) {
      console.warn('Speech recognition unavailable', err);
    }
  }

  private stopSpeechRecognition(clear = true): void {
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.stop();
      } catch {
        // ignore
      }
      this.recognition = null;
    }
    this.listening.set(false);
    if (clear) {
      // keep transcript unless explicitly clearing elsewhere
    }
  }

  private async finishInterview(): Promise<void> {
    if (this.connectionStatus() === 'Completed') return;

    const question = this.currentQuestion;
    const transcript = this.liveTranscript().trim();
    const answers: InterviewAnswerEntry[] = [];
    if (question && transcript) {
      answers.push({
        questionNo: question.questionNo,
        question: question.question,
        transcript,
        answeredAt: new Date().toISOString(),
      });
    }

    this.saving.set(true);
    this.stopSpeechRecognition();

    this.interviewService
      .saveInterviewAnswers(this.interviewId, {
        answers,
        completed: true,
      })
      .subscribe({
        next: async () => {
          this.saving.set(false);
          this.connectionStatus.set('Completed');
          await this.leaveRoom();
        },
        error: async (err: HttpErrorResponse) => {
          this.saving.set(false);
          this.error.set(extractApiErrorMessage(err, 'Failed to complete interview.'));
          this.connectionStatus.set('Completed');
          await this.leaveRoom();
        },
      });
  }

  private async leaveRoom(): Promise<void> {
    try {
      if (this.hmsActions) {
        await this.hmsActions.leave();
      }
    } catch {
      // ignore leave errors
    }
    this.teardownHms();
  }

  private teardownHms(): void {
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
}
