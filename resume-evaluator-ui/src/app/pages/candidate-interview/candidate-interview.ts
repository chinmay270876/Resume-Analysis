import {
  Component,
  OnDestroy,
  OnInit,
  PLATFORM_ID,
  computed,
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
  InterviewTokenResult,
  MAX_INTERVIEW_QUESTIONS,
} from '../../models';

type ConnectionStatus = 'Connecting' | 'Live' | 'Completed' | 'Error';

const MAX_SESSION_MINUTES = 30;

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
  private committedTranscript = '';
  private answerStartedAt = 0;
  private interviewId = '';
  private timerInterval: ReturnType<typeof setInterval> | null = null;
  private timeLimitHandled = false;
  private speakingUtterance: SpeechSynthesisUtterance | null = null;

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly roomWarning = signal<string | null>(null);
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
  protected readonly speaking = signal(false);
  protected readonly session = signal<CandidateInterviewSession | null>(null);
  protected readonly linkExpired = signal(false);
  protected readonly timeLimitReached = signal(false);
  protected readonly transcriptLocked = signal(false);
  protected readonly remainingMs = signal(0);

  protected readonly currentQuestion = computed(() => {
    const list = this.questions();
    const idx = this.currentIndex();
    return list[idx] || null;
  });

  protected readonly totalQuestions = MAX_INTERVIEW_QUESTIONS;
  protected readonly progressDots = Array.from({ length: MAX_INTERVIEW_QUESTIONS }, (_, i) => i);

  protected readonly questionProgressLabel = computed(() => {
    if (!this.questions().length) return 'No questions available';
    return `Question ${this.currentIndex() + 1} of ${this.totalQuestions}`;
  });

  protected readonly transcriptPlaceholder = computed(() => {
    if (!this.micEnabled()) {
      return 'Microphone is muted. Unmute to speak your answer.';
    }
    if (this.listening()) {
      return 'Listening... Speak your answer clearly';
    }
    return 'Speak your answer clearly — it will be transcribed automatically.';
  });

  protected readonly submitButtonLabel = computed(() => {
    const isLast = this.isLastQuestion();
    if (this.saving()) {
      return isLast ? 'Finishing…' : 'Submitting…';
    }
    return isLast ? 'Submit & Finish' : 'Submit Answer';
  });

  protected readonly timerLabel = computed(() => {
    const total = Math.max(0, Math.floor(this.remainingMs() / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  });

  protected readonly timerUrgent = computed(() => this.remainingMs() > 0 && this.remainingMs() <= 60_000);

  ngOnInit(): void {
    this.title.setTitle('Candidate Interview');

    if (!isPlatformBrowser(this.platformId)) {
      return;
    }

    this.routeSub = this.route.paramMap
      .pipe(
        map((params) => params.get('id') || this.route.snapshot.queryParamMap.get('id')),
        distinctUntilChanged()
      )
      .subscribe((id) => {
        if (!id) {
          this.loading.set(false);
          this.error.set('Interview ID is missing.');
          this.connectionStatus.set('Error');
          return;
        }
        this.interviewId = id;
        void this.bootstrap(id);
      });
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.tokenSub?.unsubscribe();
    this.clearSessionTimer();
    this.cancelSpeech();
    this.stopSpeechRecognition();
    this.teardownHms();
  }

  private resetTranscript(): void {
    this.committedTranscript = '';
    this.liveTranscript.set('');
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

  private isLastQuestion(): boolean {
    const n = Math.min(this.questions().length, MAX_INTERVIEW_QUESTIONS);
    return n > 0 && this.currentIndex() + 1 >= n;
  }

  protected toggleMic(): void {
    if (this.transcriptLocked()) return;
    const nextEnabled = !this.micEnabled();
    this.micEnabled.set(nextEnabled);

    if (nextEnabled) {
      this.startSpeechRecognition();
    } else {
      this.stopSpeechRecognition(false);
    }

    const actions = this.hmsActions;
    if (actions?.setLocalAudioEnabled) {
      void Promise.resolve(actions.setLocalAudioEnabled(nextEnabled)).catch((err: unknown) => {
        console.warn('Live room mic sync failed; local mute still applied.', err);
      });
    }
  }

  protected async submitCurrentAnswer(advance = true): Promise<void> {
    const question = this.currentQuestion();
    if (!question || !this.interviewId || this.saving() || this.transcriptLocked()) return;

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

    const isLast = this.isLastQuestion();
    this.saving.set(true);
    this.stopSpeechRecognition(false);

    this.interviewService
      .saveInterviewAnswers(this.interviewId, {
        answers: [answer],
        completed: Boolean(advance && isLast),
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          if (!advance) {
            if (this.micEnabled()) this.startSpeechRecognition();
            return;
          }
          if (isLast) {
            this.clearSessionTimer();
            this.cancelSpeech();
            this.connectionStatus.set('Completed');
            void this.leaveRoom();
            return;
          }
          this.currentIndex.set(this.currentIndex() + 1);
          this.resetTranscript();
          this.answerStartedAt = Date.now();
          this.speakCurrentQuestion();
        },
        error: (err: HttpErrorResponse) => {
          this.saving.set(false);
          this.roomWarning.set(extractApiErrorMessage(err, 'Failed to save answer.'));
          if (this.micEnabled()) this.startSpeechRecognition();
        },
      });
  }

  protected replayQuestion(): void {
    if (this.transcriptLocked() || this.connectionStatus() !== 'Live') return;
    this.speakCurrentQuestion(true);
  }

  protected async endCall(): Promise<void> {
    await this.finishInterview();
  }

  private async bootstrap(id: string): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.roomWarning.set(null);
    this.linkExpired.set(false);
    this.timeLimitReached.set(false);
    this.transcriptLocked.set(false);
    this.timeLimitHandled = false;
    this.clearSessionTimer();
    this.cancelSpeech();
    this.connectionStatus.set('Connecting');
    this.teardownHms();

    this.tokenSub?.unsubscribe();
    this.tokenSub = this.interviewService.getInterviewToken(id).subscribe({
      next: (result) => {
        void this.onTokenLoaded(result);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.connectionStatus.set('Error');
        if (this.isLinkExpiredError(err)) {
          this.linkExpired.set(true);
          this.error.set(null);
          return;
        }
        this.error.set(this.friendlyJoinError(err));
      },
    });
  }

  private async onTokenLoaded(result: InterviewTokenResult): Promise<void> {
    try {
      this.candidateName.set(
        result.candidateName || result.interview?.candidateName || 'Candidate'
      );
      this.session.set(result.interview || null);

      const qs = this.resolveQuestions(result).slice(0, MAX_INTERVIEW_QUESTIONS);
      this.questions.set(qs);
      this.currentIndex.set(this.initialQuestionIndex(qs, result.interview));
      this.resetTranscript();
      this.answerStartedAt = Date.now();
      this.loading.set(false);
      this.connectionStatus.set('Live');
      this.startSessionTimer(result.interview || null);
      this.speakCurrentQuestion();

      if (result.hmsError && !result.token) {
        this.roomWarning.set(
          'Live room audio is unavailable. You can still complete the interview with your microphone.'
        );
      }

      if (result.token) {
        try {
          await this.joinHmsRoom(result.token, this.candidateName());
        } catch (err: any) {
          this.roomWarning.set(
            this.friendlyRoomError(err, 'Live room audio could not connect. Continue speaking — answers are still recorded.')
          );
        }
      }
    } catch (err: any) {
      this.loading.set(false);
      this.connectionStatus.set('Error');
      this.error.set(err?.message || 'Failed to start the interview.');
    }
  }

  private resolveQuestions(result: InterviewTokenResult): CandidateInterviewQuestion[] {
    const interview = result.interview;
    const fromPayload = this.flattenQuestions(result.questions);
    if (fromPayload.length) return fromPayload;

    const fromInterview = this.flattenQuestions(interview?.questions);
    if (fromInterview.length) return fromInterview;

    return this.flattenQuestions(interview?.interviewJson);
  }

  private flattenQuestions(source: unknown): CandidateInterviewQuestion[] {
    const out: CandidateInterviewQuestion[] = [];

    const push = (raw: unknown, sectionName = '') => {
      if (raw && typeof raw === 'object' && Array.isArray((raw as { questions?: unknown }).questions)) {
        const nested = raw as { questions: unknown[]; sectionName?: string };
        nested.questions.forEach((item) => push(item, nested.sectionName || sectionName));
        return;
      }

      const text = this.questionText(raw);
      if (!text) return;
      const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      out.push({
        questionNo: out.length + 1,
        question: text,
        category: typeof obj['category'] === 'string' ? obj['category'] : null,
        difficulty: typeof obj['difficulty'] === 'string' ? obj['difficulty'] : null,
        estimatedTime: typeof obj['estimatedTime'] === 'string' ? obj['estimatedTime'] : null,
        sectionName:
          (typeof obj['sectionName'] === 'string' ? obj['sectionName'] : null) || sectionName || null,
      });
    };

    if (Array.isArray(source)) {
      source.forEach((item) => push(item));
      return out;
    }

    if (source && typeof source === 'object') {
      const obj = source as Record<string, unknown>;
      if (Array.isArray(obj['sections'])) {
        (obj['sections'] as unknown[]).forEach((item) => push(item));
        return out;
      }
      if (Array.isArray(obj['questions'])) {
        (obj['questions'] as unknown[]).forEach((item) => push(item));
        return out;
      }
      if (obj['interview']) {
        return this.flattenQuestions(obj['interview']);
      }
    }

    return out;
  }

  private questionText(raw: unknown): string {
    if (typeof raw === 'string') return raw.trim();
    if (!raw || typeof raw !== 'object') return '';
    const obj = raw as Record<string, unknown>;
    for (const key of ['question', 'text', 'prompt', 'q']) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  private initialQuestionIndex(
    questions: CandidateInterviewQuestion[],
    session: CandidateInterviewSession | null | undefined
  ): number {
    if (!questions.length) return 0;
    const answered = new Set(
      (session?.interviewDetails?.answers || [])
        .map((a) => Number(a.questionNo))
        .filter((n) => Number.isFinite(n))
    );
    const next = questions.findIndex((q) => !answered.has(q.questionNo));
    return next === -1 ? Math.max(0, questions.length - 1) : next;
  }

  private friendlyJoinError(err: HttpErrorResponse): string {
    if (this.isLinkExpiredError(err)) {
      return 'This interview link has expired.';
    }
    if (err.status === 403) {
      return extractApiErrorMessage(err, 'This interview cannot be joined.');
    }
    if (err.status === 404) {
      return 'Interview not found.';
    }
    if (err.status === 503) {
      return extractApiErrorMessage(err, 'The live interview room is unavailable right now.');
    }
    return extractApiErrorMessage(err, 'Failed to start interview.');
  }

  private friendlyRoomError(err: unknown, fallback: string): string {
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message?: unknown }).message || '')
        : '';
    if (/not-allowed|permission|denied/i.test(message)) {
      return 'Microphone permission was blocked. Allow the microphone to continue.';
    }
    if (/expired|invalid token|401/i.test(message)) {
      return 'The interview token expired or is invalid. Refresh this page to request a new one.';
    }
    if (/invalid id|room/i.test(message)) {
      return 'Live room audio could not connect (invalid room). Continue speaking — answers are still recorded.';
    }
    if (/network|offline|failed to fetch/i.test(message)) {
      return 'Network interruption. Check your connection. Answers can still be submitted.';
    }
    return message && message.length < 180 ? message : fallback;
  }

  private async joinHmsRoom(authToken: string, userName: string): Promise<void> {
    const {
      HMSReactiveStore,
      selectIsConnectedToRoom,
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

    this.hmsUnsubscribers.push(unsubConnected);

    await this.hmsActions.join({
      userName: userName || 'Candidate',
      authToken,
      settings: {
        isAudioMuted: !this.micEnabled(),
        isVideoMuted: true,
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

    try {
      await this.hmsActions.setLocalAudioEnabled(this.micEnabled());
    } catch {
      // local mute state already applied
    }

    this.connectionStatus.set('Live');
  }

  private startSpeechRecognition(): void {
    if (!isPlatformBrowser(this.platformId)) return;
    if (!this.micEnabled() || this.transcriptLocked() || this.speaking()) return;

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      if (!this.roomWarning()?.includes('Live transcription is not supported')) {
        this.roomWarning.set(
          [this.roomWarning(), 'Live transcription is not supported in this browser. Use Chrome or Edge.']
            .filter(Boolean)
            .join(' ')
        );
      }
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
      if (
        this.connectionStatus() === 'Live' &&
        this.micEnabled() &&
        !this.transcriptLocked() &&
        !this.speaking() &&
        this.recognition === recognition
      ) {
        try {
          recognition.start();
        } catch {
          // ignore restart races
        }
      }
    };
    recognition.onerror = (event: { error?: string }) => {
      const code = event?.error || '';
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.micEnabled.set(false);
        this.listening.set(false);
        this.roomWarning.set('Microphone permission was blocked. Allow the mic to speak your answers.');
        return;
      }
      if (code === 'aborted') {
        this.listening.set(false);
        return;
      }
      this.listening.set(false);
    };
    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) {
          this.committedTranscript = `${this.committedTranscript} ${text}`.trim();
        } else {
          interim += text;
        }
      }
      this.liveTranscript.set(
        `${this.committedTranscript}${interim ? ` ${interim}` : ''}`.trim()
      );
    };

    try {
      recognition.start();
      this.recognition = recognition;
    } catch (err) {
      console.warn('Speech recognition unavailable', err);
    }
  }

  private stopSpeechRecognition(_clear = true): void {
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
  }

  private async finishInterview(): Promise<void> {
    if (this.connectionStatus() === 'Completed' || this.timeLimitReached()) return;

    const question = this.currentQuestion();
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
    this.clearSessionTimer();
    this.cancelSpeech();
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
          this.connectionStatus.set('Completed');
          this.roomWarning.set(extractApiErrorMessage(err, 'Failed to complete interview.'));
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

  private isLinkExpiredError(err: HttpErrorResponse): boolean {
    const body = err?.error;
    if (err.status === 403 && body && typeof body === 'object') {
      const code = (body as { code?: unknown }).code;
      const message = (body as { error?: unknown; message?: unknown }).error
        || (body as { message?: unknown }).message;
      if (code === 'LINK_EXPIRED') return true;
      if (typeof message === 'string' && /link expired/i.test(message)) return true;
    }
    return err.status === 403 && /link expired/i.test(extractApiErrorMessage(err, ''));
  }

  private sessionCapMinutes(session: CandidateInterviewSession | null): number {
    const duration = Number(session?.sessionCapMinutes ?? session?.durationMinutes ?? MAX_SESSION_MINUTES);
    if (!Number.isFinite(duration) || duration <= 0) return MAX_SESSION_MINUTES;
    return Math.min(Math.round(duration), MAX_SESSION_MINUTES);
  }

  private startSessionTimer(session: CandidateInterviewSession | null): void {
    this.clearSessionTimer();
    const capMs = this.sessionCapMinutes(session) * 60 * 1000;
    const startedRaw = session?.interviewDetails?.startedAt;
    const startedAt = startedRaw ? new Date(startedRaw).getTime() : Date.now();
    const endsAt = (Number.isFinite(startedAt) ? startedAt : Date.now()) + capMs;

    const tick = () => {
      const remaining = Math.max(0, endsAt - Date.now());
      this.remainingMs.set(remaining);
      if (remaining <= 0) {
        this.clearSessionTimer();
        void this.onTimeLimitReached();
      }
    };

    tick();
    if (this.remainingMs() > 0) {
      this.timerInterval = setInterval(tick, 250);
    }
  }

  private clearSessionTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  private async onTimeLimitReached(): Promise<void> {
    if (this.timeLimitHandled || this.connectionStatus() === 'Completed') return;
    this.timeLimitHandled = true;
    this.transcriptLocked.set(true);
    this.timeLimitReached.set(true);
    this.cancelSpeech();
    this.stopSpeechRecognition();

    const question = this.currentQuestion();
    const transcript = this.liveTranscript().trim();
    const answers: InterviewAnswerEntry[] = [];
    if (question) {
      answers.push({
        questionNo: question.questionNo,
        question: question.question,
        transcript,
        answeredAt: new Date().toISOString(),
      });
    }

    this.saving.set(true);
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
        error: async () => {
          this.saving.set(false);
          this.connectionStatus.set('Completed');
          await this.leaveRoom();
        },
      });
  }

  private speakCurrentQuestion(replay = false): void {
    if (!isPlatformBrowser(this.platformId) || this.transcriptLocked()) return;
    const question = this.currentQuestion();
    const text = question?.question?.trim();
    if (!text) {
      if (this.micEnabled()) this.startSpeechRecognition();
      return;
    }

    const synth = window.speechSynthesis;
    if (!synth) {
      if (this.micEnabled()) this.startSpeechRecognition();
      return;
    }

    this.stopSpeechRecognition(false);
    this.cancelSpeech();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.lang = 'en-US';
    this.speakingUtterance = utterance;
    this.speaking.set(true);

    const resumeListening = () => {
      if (this.speakingUtterance !== utterance) return;
      this.speakingUtterance = null;
      this.speaking.set(false);
      if (
        this.connectionStatus() === 'Live' &&
        this.micEnabled() &&
        !this.transcriptLocked()
      ) {
        this.startSpeechRecognition();
      }
    };

    utterance.onend = resumeListening;
    utterance.onerror = resumeListening;

    window.setTimeout(() => {
      if (this.speakingUtterance !== utterance || this.transcriptLocked()) return;
      try {
        synth.speak(utterance);
      } catch {
        resumeListening();
      }
    }, replay ? 0 : 100);
  }

  private cancelSpeech(): void {
    this.speakingUtterance = null;
    this.speaking.set(false);
    if (!isPlatformBrowser(this.platformId)) return;
    try {
      window.speechSynthesis?.cancel();
    } catch {
      // ignore
    }
  }
}
