import { Component, inject, PLATFORM_ID, signal } from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { ResumeQueueService } from '../../services/resume-queue';
import { ResumeTask } from '../../models';
import { ResumeCard } from '../../components/resume-card/resume-card';

@Component({
  selector: 'app-upload',
  standalone: true,
  imports: [CommonModule, ResumeCard],
  templateUrl: './upload.html',
  styleUrl: './upload.css',
})
export class Upload {
  private readonly queue = inject(ResumeQueueService);
  private readonly platformId = inject(PLATFORM_ID);

  protected readonly tasks = this.queue.tasks;
  protected readonly isProcessing = this.queue.isProcessing;
  protected readonly overall = this.queue.overall;
  protected readonly maxFiles = this.queue.maxFiles;
  protected readonly downloadingBatch = this.queue.batchDownloading;
  protected readonly downloadingReportId = this.queue.downloadingReportId;

  protected readonly isDragOver = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly showQueue = signal(false);

  protected onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length) {
      this.handleFiles(files);
    }
    input.value = '';
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length) {
      this.handleFiles(files);
    }
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isProcessing()) {
      this.isDragOver.set(true);
    }
  }

  protected onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  protected onZoneKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      input?.click();
    }
  }

  protected onZoneClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('label') || target?.tagName === 'INPUT') {
      return;
    }
    if (!this.isProcessing() && this.tasks().length < this.maxFiles) {
      const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      input?.click();
    }
  }

  private handleFiles(files: FileList | File[]): void {
    const error = this.queue.addFiles(files);
    if (error) {
      this.error.set(error);
      return;
    }
    this.error.set(null);
    this.showQueue.set(true);
  }

  protected removeResume(id: string): void {
    this.queue.removeTask(id);
    if (this.tasks().length === 0) {
      this.showQueue.set(false);
    }
  }

  protected startProcessing(): void {
    this.error.set(null);
    this.queue.start();
  }

  protected resetAll(): void {
    this.queue.clearCompleted();
    this.showQueue.set(false);
    this.error.set(null);
  }

  protected onDownloadTranscript(task: ResumeTask): void {
    this.queue.downloadTranscript(task);
  }

  protected onDownloadReport(task: ResumeTask): void {
    this.queue.downloadReport(task);
  }

  protected onDownloadPodcast(task: ResumeTask): void {
    this.queue.downloadPodcast(task);
  }

  protected onDownloadBatchReport(): void {
    this.queue.downloadBatchReport();
  }

  protected overallProgress(): number {
    const o = this.overall();
    if (o.total === 0) {
      return 0;
    }
    return Math.round((o.completed / o.total) * 100);
  }

  protected formatTime(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${mm}:${ss}`;
  }

  protected trackByTask(index: number, task: ResumeTask): string {
    return task.id;
  }
}
