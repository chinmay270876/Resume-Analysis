import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { InterviewTranscript } from '../../models';

@Component({
  selector: 'app-interview-viewer',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './interview-viewer.html',
  styleUrl: './interview-viewer.css',
})
export class InterviewViewer {
  @Input() transcript: InterviewTranscript | null = null;
}
