import { ComponentFixture, TestBed } from '@angular/core/testing';
import { convertToParamMap, provideRouter, ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { RecruiterInterviewComponent } from './recruiter-interview';

describe('RecruiterInterviewComponent', () => {
  let component: RecruiterInterviewComponent;
  let fixture: ComponentFixture<RecruiterInterviewComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RecruiterInterviewComponent],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ id: 'test-interview' }) } },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RecruiterInterviewComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('should create and stay idle until Join Interview is clicked', () => {
    expect(component).toBeTruthy();
    expect(component['interviewId']).toBe('test-interview');
    expect(component['connectionStatus']()).toBe('Idle');
  });
});
