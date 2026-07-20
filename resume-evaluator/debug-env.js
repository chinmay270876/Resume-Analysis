
const dotenv = require('dotenv');
const { OpenAI } = require('openai');

// Load environment variables from .env file
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

console.log('--- OpenAI API Key Debugger ---');

if (apiKey) {
  const maskedKey = apiKey.substring(0, 5) + '...'.padEnd(apiKey.length - 10, '*') + apiKey.substring(apiKey.length - 5);
  console.log(`[INFO] Found OPENAI_API_KEY: ${maskedKey}`);
} else {
  console.error('[ERROR] OPENAI_API_KEY not found in process.env. Make sure it is set in your .env file.');
  process.exit(1);
}

console.log('[INFO] Instantiating OpenAI client...');
const openai = new OpenAI({
  apiKey: apiKey,
});

async function verifyApiKey() {
  console.log('[INFO] Making a test call to openai.models.list() to verify the key...');
  try {
    const models = await openai.models.list();
    console.log('[SUCCESS] API key is valid! Successfully fetched models.');
    // Log first 3 models for confirmation
    console.log('--- Available Models (sample) ---');
    models.data.slice(0, 3).forEach(model => console.log(`- ${model.id}`));
    console.log('---------------------------------');

  } catch (error) {
    console.error('[ERROR] API key verification failed.');
    if (error.response) {
      // Axios-like error structure from the openai library
      console.error(`  - Status: ${error.response.status}`);
      console.error(`  - Message: ${error.response.data.error ? error.response.data.error.message : 'No detailed message.'}`);
    } else {
      console.error(`  - Message: ${error.message}`);
    }
    console.log('\n[HINT] The error above likely indicates an invalid or incorrectly configured API key.');
  }
}

verifyApiKey();
