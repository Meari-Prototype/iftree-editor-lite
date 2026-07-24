// Agent/summary prompt catalog. This module is pure and safe in both browser and Node builds.
export function parsePromptCatalog(markdown: unknown): Record<string, string> {
  const text = String(markdown || '');
  const catalog: Record<string, string> = {};
  const pattern = /^##\s+(.+?)\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1].trim();
    if (key) catalog[key] = match[2].trim();
  }
  return catalog;
}

export function interpolateMessage(template: unknown, vars: Record<string, unknown> = {}): string {
  return String(template || '').replace(
    /\{\{([A-Za-z0-9_]+)\}\}/g,
    (_: string, key: string) => String(vars[key] ?? '')
  );
}

export function renderPrompt(
  catalog: Record<string, string> | null | undefined,
  key: string,
  vars: Record<string, unknown> = {},
  fallback = ''
): string {
  const hasKey = catalog && Object.prototype.hasOwnProperty.call(catalog, key);
  return interpolateMessage(hasKey ? catalog[key] : fallback, vars);
}
