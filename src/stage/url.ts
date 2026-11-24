// Resolve app files relative to the page, so the stage works at the site root (dev server)
// and under a sub-path such as https://lingcode.dev/apps/<app-id>/ (static hosting).
export const url = (p: string) => p.replace(/^\/+/, '');
