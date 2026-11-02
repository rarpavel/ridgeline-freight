import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-2xl font-semibold">Ridgeline Freight RAG Assistant</h1>
      <Button asChild>
        <Link href="/login">Sign in</Link>
      </Button>
    </main>
  );
}
