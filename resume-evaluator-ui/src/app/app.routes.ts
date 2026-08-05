import { Routes } from '@angular/router';
import { Upload } from './pages/upload/upload';
import { Dashboard } from './pages/dashboard/dashboard';
import { InterviewDetail } from './pages/interview-detail/interview-detail';

export const routes: Routes = [
    {
        path: '',
        component: Upload,
    },
    {
        path: 'dashboard',
        component: Dashboard,
    },
    {
        path: 'interviews/:id',
        component: InterviewDetail,
    },
    {
        path: '**',
        redirectTo: '',
        pathMatch: 'full',
    },
];
