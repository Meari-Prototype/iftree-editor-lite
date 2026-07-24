// Node-only prompt file loader. UI language selection must not import this module.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parsePromptCatalog } from './prompt-catalog.js';

export const DEFAULT_PROMPT_LOCALE = 'zh';

export function loadPromptCatalog(baseDir: string, locale = DEFAULT_PROMPT_LOCALE): Record<string, string> {
  const fileFor = (loc: string) => (loc === DEFAULT_PROMPT_LOCALE
    ? join(baseDir, 'system_prompt.md')
    : join(baseDir, `system_prompt.${loc}.md`));
  let path = fileFor(locale);
  if (!existsSync(path)) path = fileFor(DEFAULT_PROMPT_LOCALE);
  if (!existsSync(path)) return {};
  return parsePromptCatalog(readFileSync(path, 'utf8'));
}
