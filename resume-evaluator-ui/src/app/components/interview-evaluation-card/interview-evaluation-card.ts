import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  InterviewEvaluation,
  InterviewResult,
  ScoreWithReason,
} from '../../models';

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

export interface EvalCategoryRow {
  key: string;
  label: string;
  score: number | null;
  reason: string;
  weight?: string;
}

@Component({
  selector: 'app-interview-evaluation-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './interview-evaluation-card.html',
  styleUrl: './interview-evaluation-card.css',
})
export class InterviewEvaluationCard {
  @Input() evaluation: InterviewEvaluation | null = null;
  @Input() interviewResult: InterviewResult | string | null = null;
  @Input() interviewCompleted = false;
  @Input() evaluationDownloadHref: string | null = null;
  @Input() canRetry = false;
  @Input() retryLoading = false;

  @Output() retry = new EventEmitter<void>();

  protected readonly ringCircumference = RING_CIRCUMFERENCE;

  protected trackByIndex(index: number): number {
    return index;
  }

  protected trackByKey(_index: number, row: EvalCategoryRow): string {
    return row.key;
  }

  protected categoryScore(
    nested: ScoreWithReason | number | null | undefined,
    flat: number | null | undefined
  ): number | null {
    if (nested && typeof nested === 'object' && nested.score != null) {
      return nested.score;
    }
    if (typeof nested === 'number') return nested;
    if (flat != null) return flat;
    return null;
  }

  protected categoryReason(
    nested: ScoreWithReason | number | null | undefined
  ): string {
    if (nested && typeof nested === 'object' && nested.reason) {
      return nested.reason;
    }
    return '';
  }

  protected categories(): EvalCategoryRow[] {
    const e = this.evaluation;
    if (!e) return [];
    return [
      {
        key: 'technical',
        label: 'Technical Knowledge',
        score: this.categoryScore(e.technicalKnowledge, e.technicalScore),
        reason: this.categoryReason(e.technicalKnowledge),
        weight: '40%',
      },
      {
        key: 'jdMatch',
        label: 'JD Match',
        score: this.categoryScore(e.jdMatch, e.jdMatchPercent),
        reason: this.categoryReason(e.jdMatch),
        weight: '25%',
      },
      {
        key: 'problemSolving',
        label: 'Problem Solving',
        score: this.categoryScore(e.problemSolving, e.problemSolvingScore),
        reason: this.categoryReason(e.problemSolving),
        weight: '15%',
      },
      {
        key: 'communication',
        label: 'Communication',
        score: this.categoryScore(e.communication, e.communicationScore),
        reason: this.categoryReason(e.communication),
        weight: '10%',
      },
      {
        key: 'behaviour',
        label: 'Behaviour',
        score: this.categoryScore(e.behaviour, e.behaviourScore),
        reason: this.categoryReason(e.behaviour),
        weight: '10%',
      },
      {
        key: 'confidence',
        label: 'Confidence',
        score: this.categoryScore(e.confidence, e.confidencePercent),
        reason: this.categoryReason(e.confidence),
      },
    ];
  }

  protected overallScore(): number | null {
    return this.evaluation?.overallScore ?? null;
  }

  protected ringOffset(score: number | null): number {
    if (score === null || score === undefined) {
      return RING_CIRCUMFERENCE;
    }
    const clamped = Math.max(0, Math.min(100, score));
    return RING_CIRCUMFERENCE - (clamped / 100) * RING_CIRCUMFERENCE;
  }

  protected scoreClass(score: number | null): string {
    if (score === null || score === undefined) return 'score-na';
    if (score >= 90) return 'score-high';
    if (score >= 70) return 'score-good';
    if (score >= 50) return 'score-mid';
    return 'score-low';
  }

  protected hiringResult(): string {
    return (
      this.evaluation?.result ||
      this.interviewResult ||
      'Pending'
    );
  }

  protected resultClass(): string {
    const value = this.hiringResult().toLowerCase();
    if (value === 'selected') return 'result-selected';
    if (value === 'rejected') return 'result-rejected';
    return 'result-pending';
  }

  protected recommendationClass(): string {
    const value = (this.evaluation?.recommendation || '').toLowerCase();
    if (value.includes('strongly')) return 'rec-strong';
    if (value.includes('with training')) return 'rec-training';
    if (value.includes('borderline')) return 'rec-borderline';
    if (value.includes('rejected')) return 'rec-rejected';
    if (value.includes('recommended')) return 'rec-recommended';
    return 'rec-pending';
  }

  protected onRetry(): void {
    this.retry.emit();
  }
}
