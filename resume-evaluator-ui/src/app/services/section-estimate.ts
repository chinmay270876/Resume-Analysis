import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Subscription } from 'rxjs';

export interface SectionEstimateSnapshot {
  progress: number;
  remainingSeconds: number;
}

interface ActiveEstimate {
  startMs: number;
  totalMs: number;
}

/**
 * Shared estimated-readiness ticker for analysis sections.
 * Progress is an estimate only — actual API readiness always wins.
 * Uses one interval for all active sections to avoid orphaned timers.
 */
@Injectable({ providedIn: 'root' })
export class SectionEstimateService {
  private readonly platformId = inject(PLATFORM_ID);
  private readonly active = new Map<string, ActiveEstimate>();
  private ticker: Subscription | null = null;

  /** id → snapshot (immutable updates for change detection). */
  readonly snapshots = signal<Record<string, SectionEstimateSnapshot>>({});
  /** Increments on clearAll so section shells can restart estimates safely. */
  readonly epoch = signal(0);

  /** Begin / restart an estimated countdown for a section. */
  start(id: string, estimatedSeconds: number): void {
    const totalMs = Math.max(1, estimatedSeconds) * 1000;
    this.active.set(id, { startMs: Date.now(), totalMs });
    this.publish();
    this.ensureTicker();
  }

  /** Stop estimating a section (ready, error, or cancelled). */
  stop(id: string): void {
    if (!this.active.has(id)) {
      return;
    }
    this.active.delete(id);
    const next = { ...this.snapshots() };
    delete next[id];
    this.snapshots.set(next);
    if (this.active.size === 0) {
      this.stopTicker();
    }
  }

  /** Clear every estimate (new analysis / clear results). */
  clearAll(): void {
    this.active.clear();
    this.snapshots.set({});
    this.stopTicker();
    this.epoch.update((v) => v + 1);
  }

  get(id: string): SectionEstimateSnapshot | null {
    return this.snapshots()[id] ?? null;
  }

  private ensureTicker(): void {
    if (!isPlatformBrowser(this.platformId) || this.ticker) {
      return;
    }
    this.ticker = new Subscription();
    const handle = setInterval(() => this.publish(), 250);
    this.ticker.add(() => clearInterval(handle));
  }

  private stopTicker(): void {
    this.ticker?.unsubscribe();
    this.ticker = null;
  }

  private publish(): void {
    if (this.active.size === 0) {
      this.snapshots.set({});
      return;
    }
    const now = Date.now();
    const next: Record<string, SectionEstimateSnapshot> = {};
    for (const [id, est] of this.active) {
      const elapsed = Math.max(0, now - est.startMs);
      const ratio = Math.min(0.99, elapsed / est.totalMs);
      const remainingMs = Math.max(0, est.totalMs - elapsed);
      next[id] = {
        progress: Math.round(ratio * 100),
        remainingSeconds: Math.ceil(remainingMs / 1000),
      };
    }
    this.snapshots.set(next);
  }
}
