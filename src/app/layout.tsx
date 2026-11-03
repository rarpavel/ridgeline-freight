import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';

import { SiteFooter } from '@/components/SiteFooter';

import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'Ridgeline Freight RAG Assistant',
    template: '%s · Ridgeline Freight RAG Assistant',
  },
  description: 'RAG assistant over the documents of a fictional US logistics company.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
