import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { UploadResult, UploadProgress } from '../models';
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

    getUploadProgress(uploadId: string): Observable<UploadProgress> {
        const url = `${this.apiBase}/api/upload-progress/${encodeURIComponent(uploadId)}`;
        return this.http.get<UploadProgress>(url).pipe(
            catchError(this.handleError)
        );
    }

    private handleError(error: HttpErrorResponse) {
        console.error('An API error occurred', error.error);
        return throwError(() => error);
    }

}