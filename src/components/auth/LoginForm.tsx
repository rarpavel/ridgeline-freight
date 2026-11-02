'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface DemoAccountRow {
  id: string;
  role: string;
  demoPassword?: string | undefined;
}

const NETWORK_ERROR = 'Could not reach the server. Try again.';

export function LoginForm({ accounts, next }: { accounts: DemoAccountRow[]; next: string }) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
      });
      if (response.ok) {
        // A full navigation, so the next page is rendered with the new cookie.
        window.location.assign(next);
        return;
      }
      const body = (await response.json()) as { error: { message: string } };
      setError(body.error.message);
    } catch {
      setError(NETWORK_ERROR);
    }
    setIsSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          Account
          <Input
            name="account"
            autoComplete="username"
            required
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          Password
          <Input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Demo accounts</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Password</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">Use</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map(({ id, demoPassword }) => (
              <TableRow key={id}>
                <TableCell>{id}</TableCell>
                <TableCell className="font-mono text-xs">{demoPassword ?? '—'}</TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!demoPassword}
                    onClick={() => {
                      setAccount(id);
                      setPassword(demoPassword ?? '');
                      setError(null);
                    }}
                  >
                    Use
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
