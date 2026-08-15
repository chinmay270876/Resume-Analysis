import { Routes } from '@angular/router';
import { Upload } from './pages/upload/upload';
import { Dashboard } from './pages/dashboard/dashboard';
import { InterviewDetail } from './pages/interview-detail/interview-detail';
import { RecruiterInterviewComponent } from './pages/recruiter-interview/recruiter-interview';
import { CandidateInterviewComponent } from './pages/candidate-interview/candidate-interview';

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
        path: 'interviews/:id/join',
        component: RecruiterInterviewComponent,
    },
    {
        path: 'candidate-interview/:id',
        component: CandidateInterviewComponent,
    },
    {
        path: '**',
        redirectTo: '',
        pathMatch: 'full',
    },
];
