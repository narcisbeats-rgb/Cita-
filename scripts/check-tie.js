import { checkMadridTieAvailability } from '../src/icpplus.js';

const safeMode = process.env.SAFE_MODE !== 'false';

const result = await checkMadridTieAvailability({
  safeMode,
  headless: process.env.HEADLESS !== 'false',
  client: safeMode ? null : {
    document: process.env.CLIENT_DOCUMENT || '',
    name: process.env.CLIENT_NAME || ''
  }
});

console.log(JSON.stringify(result, null, 2));
process.exit(result.state === 'ERROR' ? 1 : 0);
