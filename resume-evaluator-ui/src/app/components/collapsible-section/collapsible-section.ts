import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SectionEstimateService } from '../../services/section-estimate';

const RING = 2 * Math.PI * 16; // r=16 in 40x40 viewBox

/**
 * Independent analysis-section shell:
 * Waiting + circular estimate → Ready to View → expand/collapse content.
 * Actual readiness is driven by parent inputs (API state), not the timer.
 */
@Component({
  selector: 'app-collapsible-section',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './collapsible-section.html',
  styleUrl: './collapsible-section.css',
})
export class CollapsibleSection {
  private readonly estimates = inject(SectionEstimateService);
  private readonly destroyRef = inject(DestroyRef);

  readonly title = input.required<string>();
  /** Unique id for aria + estimate tracking (stable across renders). */
  readonly sectionId = input.required<string>();
  /** Section processing has started (show Waiting). */
  readonly waiting = input(false);
  /** Required data is available from the API. */
  readonly ready = input(false);
  /** Error message when generation failed; null/empty = no error. */
  readonly error = input<string | null>(null);
  /** Estimated seconds until ready (progress UI only). */
  readonly estimatedSeconds = input(30);
  /** Optional badge above the title (preserves existing design language). */
  readonly badge = input<string | null>(null);

  protected readonly expanded = signal(false);
  private trackedId: string | null = null;
  private estimateStarted = false;
  private startedEpoch = -1;

  protected readonly contentId = computed(() => `${this.sectionId()}-content`);

  protected readonly hasError = computed(() => {
    const err = this.error();
    return !!err && err.trim().length > 0;
  });

  protected readonly isReady = computed(() => this.ready() && !this.hasError());

  protected readonly isWaiting = computed(
    () => this.waiting() && !this.isReady() && !this.hasError()
  );

  protected readonly estimate = computed(() => {
    const snap = this.estimates.snapshots()[this.sectionId()];
    return snap ?? { progress: 0, remainingSeconds: this.estimatedSeconds() };
  });

  protected readonly ringOffset = computed(() => {
    const pct = Math.max(0, Math.min(100, this.estimate().progress));
    return RING - (pct / 100) * RING;
  });

  protected readonly circumference = RING;

  constructor() {
    effect(() => {
      const id = this.sectionId();
      const waiting = this.isWaiting();
      const estimatedSeconds = this.estimatedSeconds();
      const epoch = this.estimates.epoch();

      if (this.trackedId && this.trackedId !== id) {
        this.estimates.stop(this.trackedId);
        this.estimateStarted = false;
        this.startedEpoch = -1;
        this.expanded.set(false);
      }
      this.trackedId = id;

      if (waiting) {
        // Restart when clearAll() bumps epoch (new analysis) while still waiting.
        if (!this.estimateStarted || this.startedEpoch !== epoch) {
          this.estimates.start(id, estimatedSeconds);
          this.estimateStarted = true;
          this.startedEpoch = epoch;
        }
        this.expanded.set(false);
        return;
      }

      if (this.estimateStarted) {
        this.estimates.stop(id);
        this.estimateStarted = false;
      }
    });

    this.destroyRef.onDestroy(() => {
      if (this.trackedId) {
        this.estimates.stop(this.trackedId);
      }
    });
  }

  protected onPrimaryAction(): void {
    if (this.hasError() || this.isWaiting()) {
      return;
    }
    if (this.isReady()) {
      this.expanded.update((v) => !v);
    }
  }

  protected onToggleExpand(): void {
    if (!this.isReady()) {
      return;
    }
    this.expanded.update((v) => !v);
  }

  protected primaryLabel(): string {
    if (this.hasError()) {
      return 'Error';
    }
    if (this.isWaiting()) {
      return 'Waiting';
    }
    if (this.expanded()) {
      return 'Collapse';
    }
    return 'Ready to View';
  }
}
