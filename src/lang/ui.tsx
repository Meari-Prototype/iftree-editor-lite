import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react';

import {
  DEFAULT_UI_LOCALE,
  isUiLanguagePreference,
  resolveUiLocale,
  UI_LANGUAGE_PACKS,
  type UiLanguagePreference,
  type UiLocale,
  type UiMessages
} from './catalog.js';

export const UI_LANGUAGE_STORAGE_KEY = 'iftree.uiLanguage';

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? [...navigator.languages] : [navigator.language];
}

export function readUiLanguagePreference(): UiLanguagePreference {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    return isUiLanguagePreference(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

function persistUiLanguagePreference(preference: UiLanguagePreference): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // Keep the in-memory preference when storage is unavailable.
  }
}

export function readResolvedUiLocale(): UiLocale {
  return resolveUiLocale(readUiLanguagePreference(), browserLanguages());
}

export function getUiMessages(): UiMessages {
  return UI_LANGUAGE_PACKS[readResolvedUiLocale()].messages;
}

interface UiLanguageContextValue {
  preference: UiLanguagePreference;
  locale: UiLocale;
  messages: UiMessages;
  setPreference(preference: UiLanguagePreference): void;
}

const UiLanguageContext = createContext<UiLanguageContextValue | null>(null);

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<UiLanguagePreference>(readUiLanguagePreference);
  const [systemLanguagesVersion, setSystemLanguagesVersion] = useState(0);
  const locale = useMemo(
    () => resolveUiLocale(preference, browserLanguages()),
    [preference, systemLanguagesVersion]
  );
  const messages = UI_LANGUAGE_PACKS[locale].messages;

  const setPreference = useCallback((next: UiLanguagePreference) => {
    persistUiLanguagePreference(next);
    setPreferenceState(next);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== UI_LANGUAGE_STORAGE_KEY) return;
      setPreferenceState(isUiLanguagePreference(event.newValue) ? event.newValue : 'auto');
    };
    const onLanguageChange = () => setSystemLanguagesVersion((value) => value + 1);
    window.addEventListener('storage', onStorage);
    window.addEventListener('languagechange', onLanguageChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('languagechange', onLanguageChange);
    };
  }, []);

  const value = useMemo<UiLanguageContextValue>(
    () => ({ preference, locale, messages, setPreference }),
    [preference, locale, messages, setPreference]
  );

  return <UiLanguageContext.Provider value={value}>{children}</UiLanguageContext.Provider>;
}

export function useUiLanguage(): UiLanguageContextValue {
  const value = useContext(UiLanguageContext);
  if (!value) {
    return {
      preference: 'auto',
      locale: DEFAULT_UI_LOCALE,
      messages: UI_LANGUAGE_PACKS[DEFAULT_UI_LOCALE].messages,
      setPreference: persistUiLanguagePreference
    };
  }
  return value;
}
