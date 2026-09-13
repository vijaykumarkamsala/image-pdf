/** Build a header-injection-safe attachment value with an ASCII fallback. */
export function attachment(filename: string): string {
  const normalized = filename.normalize("NFC").replace(/[\0-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu, "_");
  const safe = normalized.replace(/[^a-zA-Z0-9._ -]/g, "_").replace(/["\\]/g, "_").slice(0, 120) || "download";
  const encoded = encodeURIComponent(normalized).replace(/['()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}
