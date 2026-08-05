import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  CreateInterviewPayload,
  InterviewDetailResult,
  InterviewListFilter,
  InterviewListResult,
  ScheduledInterview,
} from '../models';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root',
})
export class InterviewService {
  private apiBase = environment.apiUrl.replace(/\/api$/, '');

  constructor(private http: HttpClient) {}

  createInterview(payload: CreateInterviewPayload): Observable<InterviewDetailResult> {
    return this.http
      .post<InterviewDetailResult>(`${this.apiBase}/api/interviews`, payload)
      .pipe(catchError(this.handleError));
  }

  listInterviews(options?: {
    filter?: InterviewListFilter;
    status?: string;
  }): Observable<InterviewListResult> {
    let params = new HttpParams();
    if (options?.filter) {
      params = params.set('filter', options.filter);
    }
    if (options?.status) {
      params = params.set('status', options.status);
    }

    return this.http
      .get<InterviewListResult>(`${this.apiBase}/api/interviews`, { params })
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

  completeInterview(id: string): Observable<InterviewDetailResult> {
    return this.updateInterview(id, { status: 'Completed' });
  }

  private handleError(error: HttpErrorResponse) {
    console.error('Interview API error', error.error);
    return throwError(() => error);
  }
}
