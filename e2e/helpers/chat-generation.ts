import type { Response, Page } from '@playwright/test';
import { expect } from '@playwright/test';
export async function completedGeneration(response: Response) {
  if (!response.headers()['content-type']?.includes('text/event-stream')) return response.json();
  const id = response.request().postDataJSON().previewId;
  const handle = await response.frame().page().waitForFunction(id => (window as unknown as { __chatGenerationResults: Record<string, { error?: string }> }).__chatGenerationResults[id], id);
  const result = await handle.jsonValue(); await handle.dispose();
  expect(result.error).toBeUndefined();
  return result;

}
export async function startGeneratedRoute(page: Page) {
  await page.locator('.chat-result-card').last().getByRole('button', { name: '开始阅读', exact: true }).click();
}
