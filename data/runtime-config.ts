export function localApiOrigin() {
  return globalThis.__REPOLENS_RUNTIME__?.apiOrigin
    ?? process.env.NEXT_PUBLIC_REPOLENS_API_ORIGIN
    ?? "http://127.0.0.1:4318";
}
