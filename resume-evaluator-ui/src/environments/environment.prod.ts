export const environment = {
    production: true,
    // Compile-time default for production builds. Runtime window.__env.API_URL
    // (SSR injection) can override; never use localhost here.
    // NOTE: resume-analysis-api.onrender.com currently serves a non-Express
    // (gunicorn) 404 page. The live Node API is resume-analysis-api-so26.
    apiUrl: 'https://resume-analysis-api-so26.onrender.com/api',
    /**
     * Must match backend API_KEY in production.
     * Prefer injecting via build-time replacement — never commit a real key.
     * Download links append ?api_key= when this is set.
     */
    apiKey: '' as string,
};
