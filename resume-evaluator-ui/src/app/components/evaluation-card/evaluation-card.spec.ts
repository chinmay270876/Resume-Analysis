import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EvaluationCard } from './evaluation-card';

describe('EvaluationCard', () => {
  let component: EvaluationCard;
  let fixture: ComponentFixture<EvaluationCard>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [EvaluationCard],
    }).compileComponents();

    fixture = TestBed.createComponent(EvaluationCard);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
