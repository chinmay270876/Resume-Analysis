import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { UploadResult, UploadProgress, ParseJdResult, RankCandidatesResult, JdAnalysis, Analysis, Evaluation, GenerateInterviewResult } from '../models';
import { resolveApiBase } from '../utils/api-base';
import { extractApiErrorMessage } from '../utils/api-error';

@Injectable({
    providedIn: 'root'
})
export class ResumeService {

    private apiBase = resolveApiBase();

    constructor(
        private http: HttpClient
    ) { }

    uploadResume(file: File): Observable<UploadResult> {
        const formData = new FormData();

        formData.append(
            'resume',
            file
        );

        return this.http.post<UploadResult>(
            `${this.apiBase}/api/upload-resume`,
            formData
        ).pipe(
            catchError(this.handleError)
        );
    }

    downloadReport(filename?: string): Observable<Blob> {
        const url = filename ? `${this.apiBase}/api/download-report/${encodeURIComponent(filename)}` : `${this.apiBase}/api/download-report`;
        return this.http.get(url, {
            responseType: 'blob'
        }).pipe(
            catchError(this.handleError)
        );
    }

    downloadTranscript(filename?: string): Observable<Blob> {
        const url = filename ? `${this.apiBase}/api/download-transcript/${encodeURIComponent(filename)}` : `${this.apiBase}/api/download-transcript`;
        return this.http.get(url, {
            responseType: 'blob'
        }).pipe(
            catchError(this.handleError)
        );
    }

    downloadBatchReport(): Observable<Blob> {
        return this.http.get(
            `${this.apiBase}/api/download-batch-report`,
            {
                responseType: 'blob'
            }
        ).pipe(
            catchError(this.handleError)
        );
    }

    resetReport(): Observable<{ success: boolean; message?: string; reportFilename?: string }> {
        return this.http.post<{ success: boolean; message?: string; reportFilename?: string }>(
            `${this.apiBase}/api/reset-report`,
            {}
        ).pipe(
            catchError(this.handleError)
        );
    }

    getUploadProgress(uploadId: string): Observable<UploadProgress> {
        const url = `${this.apiBase}/api/upload-progress/${encodeURIComponent(uploadId)}`;
        return this.http.get<UploadProgress>(url).pipe(
            catchError(this.handleError)
        );
    }

    parseJobDescription(file: File): Observable<ParseJdResult> {
        const formData = new FormData();
        formData.append('jobDescription', file);

        return this.http.post<ParseJdResult>(
            `${this.apiBase}/api/parse-jd`,
            formData
        ).pipe(
            catchError(this.handleError)
        );
    }

    rankCandidates(
        jdAnalysis: JdAnalysis,
        candidates: Array<{ analysis: Analysis; evaluation: Evaluation }>
    ): Observable<RankCandidatesResult> {
        return this.http.post<RankCandidatesResult>(
            `${this.apiBase}/api/rank-candidates`,
            { jdAnalysis, candidates }
        ).pipe(
            catchError(this.handleError)
        );
    }

    generateInterview(jobDescription: File, resume?: File | null): Observable<GenerateInterviewResult> {
        const formData = new FormData();
        formData.append('jobDescription', jobDescription);
        if (resume) {
            formData.append('resume', resume);
        }

        return this.http.post<GenerateInterviewResult>(
            `${this.apiBase}/api/generate-interview`,
            formData
        ).pipe(
            catchError(this.handleError)
        );
    }

    private handleError(error: HttpErrorResponse) {
        const message = extractApiErrorMessage(error, 'Resume API request failed.');
        console.error('An API error occurred', message, error.status);
        return throwError(() => {
            const enriched = error as HttpErrorResponse & { userMessage?: string };
            enriched.userMessage = message;
            return enriched;
        });
    }

}