import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StructuredInterview, InterviewSection, InterviewQuestion } from '../../models';

@Component({
  selector: 'app-interview-questions-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './interview-questions-card.html',
  styleUrl: './interview-questions-card.css',
})
export class InterviewQuestionsCard {
  @Input() interview: StructuredInterview | null = null;

  protected trackBySection(_index: number, section: InterviewSection): string {
    return section.sectionName;
  }

  protected trackByQuestion(_index: number, question: InterviewQuestion): number {
    return question.questionNo;
  }

  protected difficultyClass(difficulty: string): string {
    const value = (difficulty || '').toLowerCase();
    if (value.startsWith('e')) return 'diff-easy';
    if (value.startsWith('h')) return 'diff-hard';
    return 'diff-medium';
  }
}
