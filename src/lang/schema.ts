// UI language-pack contract.
//
// A translator adds one built-in pack and makes it satisfy MessagesFor<typeof zhCN.messages>.
// TypeScript then reports every missing, extra, or structurally incompatible message.
export type TranslationShape<T> =
  T extends (...args: infer TArgs) => string
    ? (...args: TArgs) => string
    : T extends string
      ? string
      : T extends ReadonlyArray<infer TItem>
        ? ReadonlyArray<TranslationShape<TItem>>
        : T extends object
          ? { readonly [TKey in keyof T]: TranslationShape<T[TKey]> }
          : T;

export type MessagesFor<T> = TranslationShape<T>;

export interface UiLanguagePack<TLocale extends string, TMessages> {
  locale: TLocale;
  nativeName: string;
  messages: TMessages;
}

export function defineUiLanguagePack<const TLocale extends string, const TMessages>(
  pack: UiLanguagePack<TLocale, TMessages>
): UiLanguagePack<TLocale, TMessages> {
  return pack;
}
