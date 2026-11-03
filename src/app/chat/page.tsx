import { ChatPanel } from '@/components/chat/ChatPanel';
import { Button } from '@/components/ui/button';
import { env } from '@/env';
import { requireSession } from '@/server/auth/require';

export default async function ChatPage() {
  const { account, role } = await requireSession();

  return (
    <div className="flex flex-1 flex-col">
      <header className="border-border flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">Ridgeline Freight RAG Assistant</h1>
          <p className="text-muted-foreground truncate text-xs">
            Signed in as {account} (role: {role})
          </p>
        </div>
        <form action="/api/auth/logout" method="post">
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <ChatPanel maxQuestionChars={env.MAX_QUESTION_CHARS} />
      </main>
    </div>
  );
}
