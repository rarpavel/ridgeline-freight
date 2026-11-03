const REPOSITORY_URL = 'https://github.com/rarpavel/ridgeline-freight';

export function SiteFooter() {
  return (
    <footer className="border-border text-muted-foreground border-t px-4 py-3 text-center text-xs">
      Portfolio demo. Ridgeline Freight is fictional and every document is synthetic, with no
      personal data.{' '}
      <a href={REPOSITORY_URL} className="underline underline-offset-2">
        Source on GitHub
      </a>
    </footer>
  );
}
