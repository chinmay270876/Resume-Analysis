import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Evaluation } from '../../models';

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

@Component({
  selector: 'app-evaluation-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './evaluation-card.html',
  styleUrl: './evaluation-card.css',
})
export class EvaluationCard {
  @Input() evaluation: Evaluation | null = null;

  protected trackByIndex(index: number, _item: unknown): number {
    return index;
  }

  protected ringOffset(score: number | null): number {
    if (score === null || score === undefined) {
      return RING_CIRCUMFERENCE;
    }
    const clamped = Math.max(0, Math.min(100, score));
    return RING_CIRCUMFERENCE - (clamped / 100) * RING_CIRCUMFERENCE;
  }

  protected isSelected(): boolean {
    const text = (this.evaluation?.result ?? '').toLowerCase();
    return text.includes('selected') || text.includes('pass') || text.includes('hire');
  }

  protected isRejected(): boolean {
    const text = (this.evaluation?.result ?? '').toLowerCase();
    return text.includes('rejected') || text.includes('fail') || text.includes('no hire');
  }

  protected isHold(): boolean {
    const text = (this.evaluation?.result ?? '').toLowerCase();
    return text.includes('hold') || text.includes('pending') || text.includes('review');
  }

  protected resultLabel(): string {
    if (this.isSelected()) return 'Selected';
    if (this.isRejected()) return 'Rejected';
    if (this.isHold()) return 'Hold';
    return this.evaluation?.result ?? 'N/A';
  }
}
