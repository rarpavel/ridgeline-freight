'use client';

import { useEffect, useState } from 'react';

import { formatCountdown, type ChatFailure } from '@/lib/chat-state';

const BANNER_CLASS =
  'border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm';

function RateLimitBanner({ retryAt }: { retryAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remainingMs = retryAt - now;
  return (
    <div role="alert" className={BANNER_CLASS}>
      {remainingMs > 0 ? (
        <>
          You have reached the hourly question limit. The next window opens in{' '}
          {/* The alert is announced once; a screen reader should not read every second. */}
          <span aria-live="off" className="font-medium tabular-nums">
            {formatCountdown(remainingMs)}
          </span>
          .
        </>
      ) : (
        'The next window is open. You can ask again.'
      )}
    </div>
  );
}

export function ChatBanner({ failure }: { failure: ChatFailure }) {
  if (failure.kind === 'rate_limited') return <RateLimitBanner retryAt={failure.retryAt} />;
  return (
    <div role="alert" className={BANNER_CLASS}>
      {failure.message}
    </div>
  );
}
