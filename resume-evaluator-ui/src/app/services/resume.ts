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

    constructor(
        private http: HttpClient
    ) { }

    uploadResume(file: File): Observable<UploadResult> {
        const formData = new FormData();

        formData.append(
            'resume',
            file
        );

        const url = `${environment.apiUrl}/upload-resume`;

        return this.http.post<UploadResult>(
            url,
            formData
        ).pipe(
            catchError(this.handleError)
        );
    }

    downloadReport(filename?: string): Observable<Blob> {
        const url = filename ? `${environment.apiUrl}/download-report/${encodeURIComponent(filename)}` : `${environment.apiUrl}/download-report`;
        return this.http.get(url, {
            responseType: 'blob'
        }).pipe(
            catchError(this.handleError)
        );
    }

    downloadTranscript(filename?: string): Observable<Blob> {
        const url = filename ? `${environment.apiUrl}/download-transcript/${encodeURIComponent(filename)}` : `${environment.apiUrl}/download-transcript`;
        return this.http.get(url, {
            responseType: 'blob'
        }).pipe(
            catchError(this.handleError)
        );
    }

    downloadBatchReport(): Observable<Blob> {
        return this.http.get(
            `${environment.apiUrl}/download-batch-report`,
            {
                responseType: 'blob'
            }
        ).pipe(
            catchError(this.handleError)
        );
    }

    getUploadProgress(uploadId: string): Observable<UploadProgress> {
        const url = `${environment.apiUrl}/upload-progress/${encodeURIComponent(uploadId)}`;
        return this.http.get<UploadProgress>(url).pipe(
            catchError(this.handleError)
        );
    }

    private handleError(error: HttpErrorResponse) {
        console.error('An API error occurred', error.error);
        return throwError(() => error);
    }

}