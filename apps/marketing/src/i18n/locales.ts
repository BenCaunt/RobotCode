// `code` is Astro's locale code and the BCP 47 tag for `<html lang>` and hreflang. `path` is the URL
// segment. pt-BR lives at `/pt-br`: lowercase like every other path on the site, with the region
// kept so a future pt-PT can sit beside it. zh is Simplified Chinese.
export const LOCALES = [
  { code: "en", path: "", name: "English" },
  { code: "es", path: "es", name: "Español" },
  { code: "zh-Hans", path: "zh", name: "简体中文" },
  { code: "pt-BR", path: "pt-br", name: "Português (Brasil)" },
  { code: "fr", path: "fr", name: "Français" },
  { code: "de", path: "de", name: "Deutsch" },
  { code: "ja", path: "ja", name: "日本語" },
  { code: "ko", path: "ko", name: "한국어" },
  { code: "ru", path: "ru", name: "Русский" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

/** `getStaticPaths` entries for a `[...locale]` route: English at the root, the rest prefixed. */
export const localeStaticPaths = () =>
  LOCALES.map((entry) => ({
    params: { locale: entry.path || undefined },
    props: { locale: entry.code as Locale },
  }));
