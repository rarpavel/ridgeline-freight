import { setTimeout as sleep } from 'node:timers/promises';

import { serverUrl, withClient } from './helpers/database';

const ATTEMPTS = 30;

export default async function waitForPostgres(): Promise<void> {
  const url = serverUrl();
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await withClient(url, (client) => client.query('SELECT 1'));
      return;
    } catch (error) {
      if (attempt === ATTEMPTS) {
        // Host and port only, so the password in the URL never reaches the logs.
        const { host } = new URL(url);
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Postgres at ${host} is not ready (${cause}). Run "docker compose up -d" and check ` +
            'that the port in DATABASE_URL_DIRECT matches POSTGRES_PORT.',
        );
      }
      await sleep(1_000);
    }
  }
}
