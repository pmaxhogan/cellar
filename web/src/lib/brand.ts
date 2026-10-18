/**
 * The mark shown in the sidebar and on the About page. It is the public/
 * favicon, referenced by absolute path and bound as a plain string so Vite
 * leaves it alone: importing it (or writing a literal src in a template, which
 * the Vue plugin turns into an import in dev) would bundle it as an asset, and
 * vite.config.ts names every bundled public/ asset share-*.
 */
export const LOGO_URL = "/favicon.svg";
