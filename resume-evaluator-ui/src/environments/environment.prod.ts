export const environment = {
    production: true,
    // Prefer runtime window.__env.API_URL (injected at serve time). This is the fallback.
    apiUrl: 'https://resume-analysis-api-so26.onrender.com/api',
    /**
     * Must match backend API_KEY in production.
     * Prefer injecting via build-time replacement — never commit a real key.
     * Download links append ?api_key= when this is set.
     */
    apiKey: '' as string,
};
