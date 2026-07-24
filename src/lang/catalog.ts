import { enUS } from './packs/en-US.js';
import { zhCN } from './packs/zh-CN.js';
import type { MessagesFor } from './schema.js';

export const UI_LANGUAGE_PACKS = {
  [zhCN.locale]: zhCN,
  [enUS.locale]: enUS
} as const;

export type UiLocale = keyof typeof UI_LANGUAGE_PACKS;
export type UiMessages = MessagesFor<typeof zhCN.messages>;
export type UiLanguagePreference = 'auto' | UiLocale;

export const DEFAULT_UI_LOCALE: UiLocale = 'zh-CN';

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UI_LANGUAGE_PACKS, value);
}

export function isUiLanguagePreference(value: unknown): value is UiLanguagePreference {
  return value === 'auto' || isUiLocale(value);
}

export function resolveUiLocale(
  preference: UiLanguagePreference,
  preferredLanguages: readonly string[] = []
): UiLocale {
  if (preference !== 'auto') return preference;
  for (const requested of preferredLanguages) {
    const normalized = String(requested || '').toLowerCase();
    const exact = (Object.keys(UI_LANGUAGE_PACKS) as UiLocale[])
      .find((locale) => locale.toLowerCase() === normalized);
    if (exact) return exact;
    const language = normalized.split('-')[0];
    const sameLanguage = (Object.keys(UI_LANGUAGE_PACKS) as UiLocale[])
      .find((locale) => locale.toLowerCase().split('-')[0] === language);
    if (sameLanguage) return sameLanguage;
  }
  return DEFAULT_UI_LOCALE;
}
