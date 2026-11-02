import { loadEnvConfig } from '@next/env';

// Import this before anything that reads src/env.ts. It parses .env.local the way Next.js does,
// including the \$ escapes in DEMO_ACCOUNTS_JSON, which process.loadEnvFile would keep literally.
loadEnvConfig(process.cwd());
