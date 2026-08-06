export const environment = {
    production: true,
    // Compile-time default for production builds. Runtime window.__env.API_URL
    // (SSR injection) can override; never use localhost here.
    apiUrl: 'https://resume-analysis-api.onrender.com/api',
    /**
     * Must match backend API_KEY in production.
     * Prefer injecting via build-time replacement — never commit a real key.
     * Download links append ?api_key= when this is set.
     */
    apiKey: '' as string,
};
