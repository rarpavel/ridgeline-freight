import type { Metadata } from 'next';

import { DemoGuide } from '@/components/auth/DemoGuide';
import { LoginForm } from '@/components/auth/LoginForm';
import { safeNextPath } from '@/lib/safe-next-path';
import { listDemoAccounts } from '@/server/auth/accounts';

export const metadata: Metadata = { title: 'Sign in' };

// The account list comes from runtime env, so it must not be frozen at build time.
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const { next } = await searchParams;

  return (
    <main className="flex flex-1 flex-col items-center justify-center p-4 sm:p-8">
      <div className="flex w-full max-w-md flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">Ridgeline Freight RAG Assistant</h1>
          <p className="text-muted-foreground text-sm">
            A portfolio demo. Ridgeline Freight is fictional and every document is synthetic. Each
            account sees a different set of documents, and these demo credentials are public on
            purpose.
          </p>
        </header>
        <LoginForm
          accounts={listDemoAccounts()}
          next={safeNextPath(typeof next === 'string' ? next : null)}
        />
        <DemoGuide />
      </div>
    </main>
  );
}
