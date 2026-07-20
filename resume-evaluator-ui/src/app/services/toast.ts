import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export interface Toast {
    id: number;
    message: string;
    type: 'error' | 'success' | 'info';
}

@Injectable({
    providedIn: 'root'
})
export class ToastService {
    private readonly platformId = inject(PLATFORM_ID);
    private counter = 0;

    readonly toasts = signal<Toast[]>([]);

    show(message: string, type: Toast['type'] = 'error', duration = 4000): void {
        if (!isPlatformBrowser(this.platformId)) {
            return;
        }

        const id = ++this.counter;
        this.toasts.update((list) => [...list, { id, message, type }]);

        setTimeout(() => {
            this.toasts.update((list) => list.filter((t) => t.id !== id));
        }, duration);
    }
}
