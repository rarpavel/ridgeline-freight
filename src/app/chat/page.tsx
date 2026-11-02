import { Button } from '@/components/ui/button';
import { requireSession } from '@/server/auth/require';

// TODO(RAG-024): replace this placeholder with the chat UI; keep requireSession and sign-out.
export default async function ChatPage() {
  const { account, role } = await requireSession();

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">Ridgeline Freight RAG Assistant</h1>
      <p className="text-muted-foreground text-sm">
        Signed in as {account} (role: {role}). Chat is not available yet.
      </p>
      <form action="/api/auth/logout" method="post">
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </main>
  );
}
