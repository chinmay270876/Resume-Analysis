import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { UploadResult, UploadProgress } from '../models';

@Injectable({
    providedIn: 'root'
})
export class ResumeService {

    private apiUrl = '/api/upload-resume';

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
            this.apiUrl,
            formData
        ).pipe(
            catchError(this.handleError)
        );
    }

    downloadReport(filename?: string): Observable<Blob> {
        const url = filename ? `/api/download-report/${encodeURIComponent(filename)}` : '/api/download-report';
        return this.http.get(url, {
            responseType: 'blob'
        }).pipe(
            catchError(this.handleError)
        );
    }

    downloadTranscript(filename?: string): Observable<Blob> {
        const url = filename ? `/api/download-transcript/${encodeURIComponent(filename)}` : '/api/download-transcript';
        return this.http.get(url, {
            responseType: 'blob'
        }).pipe(
            catchError(this.handleError)
        );
    }

    downloadBatchReport(): Observable<Blob> {
        return this.http.get(
            '/api/download-batch-report',
            {
                responseType: 'blob'
            }
        ).pipe(
            catchError(this.handleError)
        );
    }

    getUploadProgress(uploadId: string): Observable<UploadProgress> {
        return this.http.get<UploadProgress>(`/api/upload-progress/${encodeURIComponent(uploadId)}`).pipe(
            catchError(this.handleError)
        );
    }

    private handleError(error: HttpErrorResponse) {
        console.error('An API error occurred', error.error);
        return throwError(() => error);
    }

}