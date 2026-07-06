import type { HighlighterCore } from "shiki/core";

/**
 * Lazy, singleton Shiki highlighter for client-side code rendering. The
 * core, JS regex engine (no WASM), and both themes load on first use via
 * dynamic `import()` so nothing reaches the initial bundle or the server;
 * grammars load per language on demand and are cached. Rendering consumes
 * the returned tokens as React spans, never raw HTML.
 */

/**
 * Static per-language grammar loaders. Explicit specifiers (not a dynamic
 * `import(\`shiki/langs/${lang}.mjs\`)` template) so the bundler can resolve
 * each via Shiki's `./*` export without enumerating a `shiki/langs`
 * directory it does not expose; each still code-splits into its own chunk.
 */
const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  java: () => import("shiki/langs/java.mjs"),
};

/** Canonical languages Shiki grammars are loaded for on demand. */
const SUPPORTED = new Set(Object.keys(LANG_LOADERS));

/** Common fence-language aliases mapped to their canonical grammar. */
const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
};

/** One highlighted token: literal text and its resolved color. */
export type HighlightToken = { content: string; color: string };

/** One highlighted source line as an ordered token list. */
export type HighlightLine = { tokens: HighlightToken[] };

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
const langLoads = new Map<string, Promise<boolean>>();

/**
 * Resolve a fence language to a supported canonical grammar name.
 *
 * @param lang - Raw fence info-string language.
 * @returns Canonical grammar name, or `null` when unsupported.
 */
export function resolveLang(lang: string): string | null {
  const key = lang.toLowerCase();
  const canonical = ALIASES[key] ?? key;
  return SUPPORTED.has(canonical) ? canonical : null;
}

/**
 * Create (once) the shared highlighter with no grammars preloaded.
 *
 * @returns The singleton highlighter instance.
 */
async function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === null) {
    highlighterPromise = (async () => {
      const [
        { createHighlighterCore },
        { createJavaScriptRegexEngine },
        dark,
        light,
      ] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
        import("shiki/themes/github-dark.mjs"),
        import("shiki/themes/github-light.mjs"),
      ]);
      return createHighlighterCore({
        themes: [dark.default, light.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

/**
 * Load a canonical grammar into the highlighter once, caching the result.
 *
 * @param hl - The highlighter instance.
 * @param lang - Canonical grammar name.
 * @returns `true` when the grammar is available, `false` on load failure.
 */
async function ensureLang(hl: HighlighterCore, lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  const loader = LANG_LOADERS[lang];
  if (loader === undefined) return false;
  let load = langLoads.get(lang);
  if (load === undefined) {
    load = (async () => {
      try {
        const mod = await loader();
        await hl.loadLanguage(
          mod.default as Parameters<typeof hl.loadLanguage>[0],
        );
        loadedLangs.add(lang);
        return true;
      } catch {
        langLoads.delete(lang);
        return false;
      }
    })();
    langLoads.set(lang, load);
  }
  return load;
}

/**
 * Tokenize code for the given language and theme.
 *
 * @param code - Raw source text.
 * @param lang - Fence info-string language.
 * @param theme - Active app theme.
 * @returns Highlighted lines, or `null` when the language is unsupported
 *   or its grammar fails to load (caller falls back to plain text).
 */
export async function highlight(
  code: string,
  lang: string,
  theme: "light" | "dark",
): Promise<HighlightLine[] | null> {
  const canonical = resolveLang(lang);
  if (canonical === null) return null;
  const hl = await getHighlighter();
  if (!(await ensureLang(hl, canonical))) return null;
  const { tokens } = hl.codeToTokens(code, {
    lang: canonical,
    theme: theme === "light" ? "github-light" : "github-dark",
  });
  return tokens.map((line) => ({
    tokens: line.map((token) => ({
      content: token.content,
      color: token.color ?? "inherit",
    })),
  }));
}
