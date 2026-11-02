import 'server-only';

export function renderPrompt(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = variables[name];
    if (value === undefined) throw new Error(`Missing prompt variable: ${name}`);
    return value;
  });
}
