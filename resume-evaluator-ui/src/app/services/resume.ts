import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { UploadResult, UploadProgress, ParseJdResult, RankCandidatesResult, JdAnalysis, Analysis, Evaluation, GenerateInterviewResult } from '../models';
import { environment } from '../../environments/environment';

@Injectable({
    providedIn: 'root'
})
export class ResumeService {

    private apiBase = environment.apiUrl.replace(/\/api$/, '');

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

    generateInterview(resume: File, jobDescription: File): Observable<GenerateInterviewResult> {
        const formData = new FormData();
        formData.append('resume', resume);
        formData.append('jobDescription', jobDescription);

        return this.http.post<GenerateInterviewResult>(
            `${this.apiBase}/api/generate-interview`,
            formData
        ).pipe(
            catchError(this.handleError)
        );
    }

    private handleError(error: HttpErrorResponse) {
        console.error('An API error occurred', error.error);
        return throwError(() => error);
    }

}