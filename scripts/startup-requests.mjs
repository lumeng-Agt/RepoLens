// A failed SSE connection is expected only when it was still live when an
// explicit, subsequently verified repository close began. Keep the raw event.
export function createStartupRequestMonitor(apiOrigin) {
  const live = new Set(), closing = new WeakSet();
  const failures = [];
  return {
    failures,
    started(request) {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.origin === apiOrigin && url.pathname === "/api/events") live.add(request);
    },
    finished(request) { live.delete(request); },
    beginRepositoryClose() { for (const request of live) closing.add(request); },
    failed(request) {
      const error = request.failure()?.errorText ?? null;
      failures.push({ url: request.url(), error, expectedCancellation: closing.has(request) && error === "net::ERR_ABORTED" });
      live.delete(request);
    },
  };
}
