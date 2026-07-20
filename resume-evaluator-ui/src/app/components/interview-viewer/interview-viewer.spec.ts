import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InterviewViewer } from './interview-viewer';

describe('InterviewViewer', () => {
  let component: InterviewViewer;
  let fixture: ComponentFixture<InterviewViewer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InterviewViewer],
    }).compileComponents();

    fixture = TestBed.createComponent(InterviewViewer);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
