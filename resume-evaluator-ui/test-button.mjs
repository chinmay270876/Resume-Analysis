import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  const consoleLogs = [];
  page.on('console', msg => {
    consoleLogs.push(`${msg.type()}: ${msg.text()}`);
  });
  
  page.on('request', request => {
    consoleLogs.push(`REQUEST: ${request.method()} ${request.url()}`);
  });
  
  try {
    await page.goto('http://localhost:4200', { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(2000);
    
    // Inject mock state via Angular context
    const injectResult = await page.evaluate(() => {
      const uploadEl = document.querySelector('app-upload');
      if (!uploadEl) return 'no upload element';
      
      const ctx = uploadEl.__ngContext__;
      if (!ctx) return 'no context';
      
      const injector = ctx.injector;
      if (!injector) return 'no injector';
      
      try {
        const ResumeQueueService = window.ng.core.ResumeQueueService;
        const queue = injector.get(ResumeQueueService);
        
        const mockTask = {
          id: 'mock-1',
          file: null,
          fileName: 'test.pdf',
          fileSize: 1024,
          order: 1,
          status: 'completed',
          progress: 100,
          stageIndex: 6,
          elapsedSeconds: 10,
          error: null,
          result: {
            raw: {
              reportPath: '/api/download-report/test.xlsx',
              reportFilename: 'test.xlsx',
              transcriptPath: '/api/download-transcript/test.txt',
              success: true
            },
            analysis: {
              candidateName: 'Test',
              email: 'test@test.com',
              phone: '123',
              currentCompany: 'Acme',
              yearsOfExperience: '5',
              skills: ['JS'],
              experience: '5 years',
              strengths: ['coding'],
              weaknesses: ['testing']
            },
            evaluation: {
              score: 85,
              skills: ['JS'],
              strengths: ['problem solving'],
              weaknesses: ['backend'],
              result: 'RECOMMENDED',
              recommendation: 'HIRE'
            },
            parsedTranscript: {
              title: 'Interview',
              summary: 'Good',
              transcriptTurns: []
            }
          }
        };
        
        queue.taskList = [mockTask];
        queue.emitTasks();
        queue.overall.set({ total: 1, completed: 1, failed: 0, elapsedSeconds: 10 });
        queue.isProcessing.set(false);
        
        return 'Mock task injected. tasks signal: ' + queue.tasks().length;
      } catch (e) {
        return 'Error: ' + e.message + ' stack: ' + e.stack;
      }
    });
    
    console.log('Injection result:', injectResult);
    
    await page.waitForTimeout(1000);
    
    // Find and click the Report Ready button
    const reportReadyBtn = await page.$('button:has-text("Report Ready")');
    console.log('Report Ready button visible:', await reportReadyBtn?.isVisible() ?? false);
    
    if (reportReadyBtn) {
      await reportReadyBtn.click();
      await page.waitForTimeout(2000);
      console.log('Clicked Report Ready button');
    }
    
    console.log('Final console logs:', consoleLogs.join('\n'));
  } catch (e) {
    console.log('Error:', e.message);
    console.log('Console logs:', consoleLogs.join('\n'));
  }
  
  await browser.close();
})();
