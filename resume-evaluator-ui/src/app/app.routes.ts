import { Routes } from '@angular/router';
import { Upload } from './pages/upload/upload';

export const routes: Routes = [
    {
        path: '',
        component: Upload
    },
    {
        path: '**',
        redirectTo: '',
        pathMatch: 'full'
    }
];