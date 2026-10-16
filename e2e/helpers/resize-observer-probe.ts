import type { Page } from '@playwright/test';

export async function installResizeObserverProbe(page: Page) {
  await page.addInitScript(() => {
    const trace = { callbacks: [] as string[], errors: [] as string[] };
    (window as Window & { __repoLensResizeTrace?: typeof trace }).__repoLensResizeTrace = trace;
    const NativeResizeObserver = window.ResizeObserver;
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: class extends NativeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          const owner = new Error().stack ?? 'unknown observer';
          super((entries, observer) => {
            trace.callbacks.push(`${owner}\n${entries.map((entry) => {
              const target = entry.target as HTMLElement;
              const ancestors: string[] = [];
              let element: HTMLElement | null = target;
              for (let depth = 0; element && depth < 5; depth += 1, element = element.parentElement) {
                const rect = element.getBoundingClientRect();
                ancestors.push(`${element.className || element.nodeName}=${rect.width}x${rect.height}/${getComputedStyle(element).display}`);
              }
              return `${target.className || entry.target.nodeName}: ${entry.contentRect.width}x${entry.contentRect.height} [${ancestors.join(' <- ')}]`;
            }).join(', ')}`);
            if (trace.callbacks.length > 24) trace.callbacks.shift();
            callback(entries, observer);
          });
        }
      },
    });
    window.addEventListener('error', (event) => {
      if (!event.message.includes('ResizeObserver loop')) return;
      const graph = document.querySelector<HTMLElement>('.graph-pane');
      const canvas = document.querySelector<HTMLElement>('.graph-canvas');
      const describe = (element: HTMLElement | null) => element && ({
        className: element.className,
        display: getComputedStyle(element).display,
        visibility: getComputedStyle(element).visibility,
        rect: `${element.getBoundingClientRect().width}x${element.getBoundingClientRect().height}`,
      });
      const detail = JSON.stringify({
        message: event.message,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        workspace: document.querySelector('.workspace-grid')?.className,
        graph: describe(graph),
        canvas: describe(canvas),
        callbacks: trace.callbacks.slice(-8).map((entry) => entry.split('\n').slice(-1)[0]),
      });
      trace.errors.push(detail);
      console.error('[RepoLens resize]', detail);
    });
  });
  const logs: string[] = [];
  page.on('console', (message) => {
    if (!message.text().startsWith('[RepoLens resize]')) return;
    logs.push(message.text());
    console.log(message.text());
  });
  return {
    async errors() {
      return page.evaluate(() => (window as Window & { __repoLensResizeTrace?: { errors: string[] } }).__repoLensResizeTrace?.errors ?? []);
    },
    logs,
  };
}
