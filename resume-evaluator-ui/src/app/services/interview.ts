import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  CompleteInterviewPayload,
  CompleteInterviewResult,
  CreateInterviewPayload,
  InterviewCompareResult,
  InterviewDetailResult,
  InterviewListFilter,
  InterviewListResult,
  InterviewRankingResult,
  InterviewSortBy,
  InterviewSortDir,
  InterviewStatsResult,
  PodcastTranscriptResult,
} from '../models';
import { resolveApiBase, withApiKeyQuery } from '../utils/api-base';

export interface InterviewListOptions {
  filter?: InterviewListFilter | string;
  status?: string;
  result?: string;
  search?: string;
  sortBy?: InterviewSortBy | string;
  sortDir?: InterviewSortDir | string;
  page?: number;
  pageSize?: number;
}

@Injectable({
  providedIn: 'root',
})
export class InterviewService {
  private apiBase = resolveApiBase();

  constructor(private http: HttpClient) {}

  createInterview(payload: CreateInterviewPayload): Observable<InterviewDetailResult> {
    return this.http
      .post<InterviewDetailResult>(`${this.apiBase}/api/interviews`, payload)
      .pipe(catchError(this.handleError));
  }

  listInterviews(options?: InterviewListOptions): Observable<InterviewListResult> {
    let params = new HttpParams();
    if (options?.filter) {
      params = params.set('filter', options.filter);
    }
    if (options?.status) {
      params = params.set('status', options.status);
    }
    if (options?.result) {
      params = params.set('result', options.result);
    }
    if (options?.search) {
      params = params.set('search', options.search);
    }
    if (options?.sortBy) {
      params = params.set('sortBy', options.sortBy);
    }
    if (options?.sortDir) {
      params = params.set('sortDir', options.sortDir);
    }
    if (options?.page != null) {
      params = params.set('page', String(options.page));
    }
    if (options?.pageSize != null) {
      params = params.set('pageSize', String(options.pageSize));
    }

    return this.http
      .get<InterviewListResult>(`${this.apiBase}/api/interviews`, { params })
      .pipe(catchError(this.handleError));
  }

  getInterviewStats(): Observable<InterviewStatsResult> {
    return this.http
      .get<InterviewStatsResult>(`${this.apiBase}/api/interviews/stats`)
      .pipe(catchError(this.handleError));
  }

  getCandidateRanking(limit = 50): Observable<InterviewRankingResult> {
    const params = new HttpParams().set('limit', String(limit));
    return this.http
      .get<InterviewRankingResult>(`${this.apiBase}/api/interviews/ranking`, { params })
      .pipe(catchError(this.handleError));
  }

  compareCandidates(ids: string[]): Observable<InterviewCompareResult> {
    const params = new HttpParams().set('ids', ids.join(','));
    return this.http
      .get<InterviewCompareResult>(`${this.apiBase}/api/interviews/compare`, { params })
      .pipe(catchError(this.handleError));
  }

  getInterview(id: string): Observable<InterviewDetailResult> {
    return this.http
      .get<InterviewDetailResult>(`${this.apiBase}/api/interviews/${encodeURIComponent(id)}`)
      .pipe(catchError(this.handleError));
  }

  updateInterview(
    id: string,
    payload: Partial<CreateInterviewPayload> & { status?: string }
  ): Observable<InterviewDetailResult> {
    return this.http
      .patch<InterviewDetailResult>(
        `${this.apiBase}/api/interviews/${encodeURIComponent(id)}`,
        payload
      )
      .pipe(catchError(this.handleError));
  }

  deleteInterview(id: string): Observable<{ success: boolean; message?: string }> {
    return this.http
      .delete<{ success: boolean; message?: string }>(
        `${this.apiBase}/api/interviews/${encodeURIComponent(id)}`
      )
      .pipe(catchError(this.handleError));
  }

  cancelInterview(id: string): Observable<InterviewDetailResult> {
    return this.updateInterview(id, { status: 'Cancelled' });
  }

  /**
   * Legacy status-only complete. Prefer completeLiveInterview with real turns.
   */
  completeInterview(id: string): Observable<InterviewDetailResult> {
    return this.updateInterview(id, { status: 'Completed' });
  }

  /**
   * Submit the REAL Voice AI conversation after the live session ends.
   * Never call this with invented / placeholder dialogue.
   */
  completeLiveInterview(
    id: string,
    payload: CompleteInterviewPayload
  ): Observable<CompleteInterviewResult> {
    return this.http
      .post<CompleteInterviewResult>(
        `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/complete`,
        payload
      )
      .pipe(catchError(this.handleError));
  }

  getTranscript(
    id: string,
    options?: { q?: string; speaker?: string; timestamp?: string }
  ): Observable<PodcastTranscriptResult> {
    let params = new HttpParams();
    if (options?.q) params = params.set('q', options.q);
    if (options?.speaker) params = params.set('speaker', options.speaker);
    if (options?.timestamp) params = params.set('timestamp', options.timestamp);

    return this.http
      .get<PodcastTranscriptResult>(
        `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/transcript`,
        { params }
      )
      .pipe(catchError(this.handleError));
  }

  transcriptDownloadUrl(id: string, format: 'txt' | 'pdf' = 'txt'): string {
    return withApiKeyQuery(
      `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/transcript/download?format=${format}`
    );
  }

  recordingDownloadUrl(id: string): string {
    return withApiKeyQuery(
      `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/recording`
    );
  }

  evaluationUrl(id: string): string {
    return `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/evaluation`;
  }

  evaluationDownloadUrl(id: string, format: 'pdf' | 'txt' = 'pdf'): string {
    return withApiKeyQuery(
      `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/evaluation/download?format=${format}`
    );
  }

  /** Final Result Module report (requires evaluation + hiring result). */
  resultReportDownloadUrl(id: string, format: 'pdf' | 'txt' = 'pdf'): string {
    return withApiKeyQuery(
      `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/result/download?format=${format}`
    );
  }

  /** Optional Excel summary (requires AI evaluation). */
  excelSummaryDownloadUrl(id: string): string {
    return withApiKeyQuery(
      `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/excel/download`
    );
  }

  reEvaluateInterview(id: string): Observable<CompleteInterviewResult> {
    return this.http
      .post<CompleteInterviewResult>(
        `${this.apiBase}/api/interviews/${encodeURIComponent(id)}/evaluate`,
        {}
      )
      .pipe(catchError(this.handleError));
  }

  rescheduleInterview(
    id: string,
    payload: { date: string; time: string; duration?: number; timezone?: string }
  ): Observable<InterviewDetailResult> {
    return this.updateInterview(id, payload);
  }

  private handleError(error: HttpErrorResponse) {
    console.error('Interview API error', error.error);
    return throwError(() => error);
  }
}
