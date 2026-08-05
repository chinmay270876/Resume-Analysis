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
  @Input() ats: {
    atsScore: number | null;
    atsGrade: string;
    atsSummary: string;
    atsBreakdown: {
      contactInformation: number;
      resumeStructure: number;
      skills: number;
      experience: number;
      education: number;
      keywordOptimization: number;
      formatting: number;
    };
    missingKeywords: string[];
    formatIssues: string[];
    recommendations: string[];
  } | null = null;

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

  protected hasAts(): boolean {
    return this.ats !== null && this.ats !== undefined;
  }

  protected atsRingOffset(): number {
    const score = this.ats?.atsScore ?? null;
    if (score === null || score === undefined) {
      return RING_CIRCUMFERENCE;
    }
    const clamped = Math.max(0, Math.min(100, score));
    return RING_CIRCUMFERENCE - (clamped / 100) * RING_CIRCUMFERENCE;
  }

  protected atsScoreClass(): string {
    const score = this.ats?.atsScore ?? -1;
    if (score === null || score === undefined) return 'score-na';
    if (score >= 90) return 'score-high';
    if (score >= 70) return 'score-good';
    if (score >= 50) return 'score-mid';
    return 'score-low';
  }

  protected atsBreakdownEntries(): { label: string; score: number; max: number }[] {
    if (!this.ats?.atsBreakdown) return [];
    const b = this.ats.atsBreakdown;
    return [
      { label: 'Contact Info', score: b.contactInformation, max: 10 },
      { label: 'Structure', score: b.resumeStructure, max: 15 },
      { label: 'Skills', score: b.skills, max: 15 },
      { label: 'Experience', score: b.experience, max: 15 },
      { label: 'Education', score: b.education, max: 10 },
      { label: 'Keywords', score: b.keywordOptimization, max: 25 },
      { label: 'Formatting', score: b.formatting, max: 10 },
    ];
  }
}
