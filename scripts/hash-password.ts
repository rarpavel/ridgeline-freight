import { randomInt } from 'node:crypto';

import { hash } from 'bcryptjs';

const COST = 10;
const ROLES = ['sales', 'hr', 'ops', 'admin'];
const PASSWORD_LENGTH = 12;
// No lookalikes (0/O, 1/l/I), since people retype these from the login page.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generatePassword(): string {
  return Array.from({ length: PASSWORD_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(
    '',
  );
}

async function main(): Promise<void> {
  const [password] = process.argv.slice(2);
  if (password) {
    console.log(await hash(password, COST));
    return;
  }

  const accounts = await Promise.all(
    ROLES.map(async (role) => {
      const demoPassword = generatePassword();
      return { id: role, role, passwordHash: await hash(demoPassword, COST), demoPassword };
    }),
  );
  const value = JSON.stringify(accounts);
  console.log(`# Vercel project env (paste the value as is):\nDEMO_ACCOUNTS_JSON=${value}\n`);
  // Next.js expands $ in .env files, even inside quotes, unless it is escaped.
  console.log(`# .env.local:\nDEMO_ACCOUNTS_JSON=${value.replaceAll('$', '\\$')}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
