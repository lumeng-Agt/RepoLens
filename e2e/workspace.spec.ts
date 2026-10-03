import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isGraphNodeWithinBounds, waitForStableGraphGeometry } from "./helpers/graph-geometry";

async function enableProgressTrace(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const traceWindow = window as Window & { __repolensProgressTrace?: Record<string, string | number | null>[] };
    traceWindow.__repolensProgressTrace = [];
    window.addEventListener("repolens:progress-trace", (event) => {
      traceWindow.__repolensProgressTrace?.push((event as CustomEvent<Record<string, string | number | null>>).detail);
    });
  });
}

async function readProgressTrace(page: import("@playwright/test").Page) {
  return page.evaluate(() => (window as Window & { __repolensProgressTrace?: Record<string, string | number | null>[] }).__repolensProgressTrace ?? []);
}

async function watchRuntimeErrors(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const diagnostics = (window as Window & { __repolensRuntimeErrors?: string[] }).__repolensRuntimeErrors ??= [];
    window.addEventListener("error", (event) => diagnostics.push(`window: ${event.message}`));
    window.addEventListener("unhandledrejection", (event) => diagnostics.push(`promise: ${String(event.reason)}`));
  });
  return errors;
}

async function expectRuntimeClean(page: import("@playwright/test").Page, consoleErrors: string[], label: string) {
  const runtimeErrors = await page.evaluate(() => (window as Window & { __repolensRuntimeErrors?: string[] }).__repolensRuntimeErrors ?? []);
  expect([...consoleErrors, ...runtimeErrors], label).toEqual([]);
  await expect(page.locator("nextjs-portal, vite-error-overlay, [data-vinext-error-overlay]")).toHaveCount(0);
}

let modelServer: Server;
let modelOrigin = "";
let modelCalls = 0;
let temporaryRepository = "";

test.beforeAll(async () => {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: { content?: string }[] };
    modelCalls += 1;
    const currentCall = modelCalls;
    const userMessage = input.messages?.find((message) => message.content?.includes("FILE "))?.content ?? "";
    const files = [...userMessage.matchAll(/^FILE ([^\r\n]+) LINES (\d+)-(\d+)/gm)];
    const file = files[0];
    const content = userMessage.includes("steps 需 3 到 7 个")
      ? JSON.stringify({ title: "模拟路线", steps: [0, 1, 2].map((index) => { const stepFile = files[index % files.length]; return { fileId: stepFile[1], purpose: `阅读步骤 ${index + 1}`, references: [{ fileId: stepFile[1], startLine: Number(stepFile[2]) }] }; }) })
      : JSON.stringify({ role: "当前文件说明", keyPoints: ["mock response"], references: [{ fileId: file?.[1] ?? "main.ts", startLine: Number(file?.[2] ?? 1) }] });
    await new Promise((resolve) => setTimeout(resolve, currentCall === 1 ? 1600 : 80));
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind mock model server.");
  modelOrigin = `http://127.0.0.1:${address.port}/v1`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  if (temporaryRepository) await rm(temporaryRepository, { recursive: true, force: true });
});

test("refresh restores the selected third step in all target viewports", async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = await watchRuntimeErrors(page);
    await enableProgressTrace(page);
    await page.goto("/?repolensDebugProgress=1");
    const thirdStep = page.getByRole("button", { name: "第 3 步：列表拆分为组件" });
    await thirdStep.click();
    await expect(thirdStep).toHaveAttribute("aria-current", "step");
    await page.reload();
    await expect(page.getByRole("button", { name: "第 3 步：列表拆分为组件" })).toHaveAttribute("aria-current", "step");
    await expect(page.getByText("导览定位 · 第 16 行")).toBeVisible();
    const trace = await readProgressTrace(page);
    const restore = trace.filter((item) => item.event === "restore-complete").at(-1);
    expect(restore).toMatchObject({ outcome: "restored", stepIndex: 2 });
    const save = trace.find((item) => item.event === "save" && item.generation === restore?.generation && item.stepIndex === 2);
    expect(save).toMatchObject({ outcome: "persistent", key: "repolens:taskflow-sample:1.2" });
    expect(typeof restore?.generation).toBe("number");
    expect(typeof restore?.key).toBe("string");
    await expectRuntimeClean(page, consoleErrors, `${viewport.width}px third-step refresh must not emit global browser errors`);
    await page.close();
  }
});

test('fresh browser sessions and reloads finish app startup without client-entry failures', async ({ browser }) => {
  for (let session = 1; session <= 2; session += 1) {
    const page = await browser.newPage();
    const evidence = { session, failedRequests: [] as { url: string; error: string | null }[], badResponses: [] as { url: string; status: number }[], clientEntryResponses: [] as { url: string; status: number }[], consoleErrors: [] as string[], pageErrors: [] as string[] };
    page.on('requestfailed', (request) => evidence.failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null }));
    page.on('response', (response) => {
      const url = response.url();
      if (response.status() >= 400) evidence.badResponses.push({ url, status: response.status() });
      if (/browser-entry|__x00__virtual/.test(url)) evidence.clientEntryResponses.push({ url, status: response.status() });
    });
    page.on('console', (message) => { if (message.type() === 'error') evidence.consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
    let passed = false;
    try {
      for (const navigation of ['initial', 'reload'] as const) {
        if (navigation === 'initial') await page.goto('/', { waitUntil: 'domcontentloaded' });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('button', { name: '第 1 步：从入口开始' })).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.graph-file-card.is-selected')).toBeVisible();
      }
      expect(evidence.failedRequests, `session ${session} had no failed browser requests`).toEqual([]);
      expect(evidence.badResponses, `session ${session} had no failed module or HTTP responses`).toEqual([]);
      expect(evidence.consoleErrors, `session ${session} had no console errors`).toEqual([]);
      expect(evidence.pageErrors, `session ${session} had no uncaught page errors`).toEqual([]);
      passed = true;
    } catch (error) {
      throw new Error(`Browser startup or reload failed with diagnostics: ${JSON.stringify(evidence)}`, { cause: error });
    } finally {
      await test.info().attach(`startup-session-${session}.json`, { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
      if (!passed) await test.info().attach(`startup-session-${session}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await page.close();
    }
  }
});

test("completed tour remains completed after refresh in all target viewports", async ({ browser }) => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    const consoleErrors = await watchRuntimeErrors(page);
    await enableProgressTrace(page);
    await page.goto("/?repolensDebugProgress=1");
    await page.getByRole("button", { name: "第 5 步：服务提供初始数据" }).click();
    await page.getByRole("button", { name: "完成导览" }).click();
    await expect(page.getByRole("button", { name: "导览已完成" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "第 5 步：服务提供初始数据" })).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("button", { name: "导览已完成" })).toBeVisible();
    const trace = await readProgressTrace(page);
    const restore = trace.filter((item) => item.event === "restore-complete").at(-1);
    expect(restore).toMatchObject({ outcome: "restored", stepIndex: 4 });
    expect(trace.some((item) => item.event === "save" && item.generation === restore?.generation && item.stepIndex === 4 && item.outcome === "persistent")).toBe(true);
    await expectRuntimeClean(page, consoleErrors, `${viewport.width}px completed-tour refresh must not emit global browser errors`);
    await page.close();
  }
});

test("selected graph node stays fully visible at desktop and phone sizes", async ({ browser }) => {
  const consoleErrors: string[] = [];
  const geometryErrors: Record<string, unknown>[] = [];
  const graphSnapshots: Record<string, unknown>[] = [];
  let graphTestStage = "setup";
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 375, height: 812 }]) {
    const page = await browser.newPage({ viewport });
    await page.addInitScript(() => {
    const traceWindow = window as Window & { __repolensGraphDiagnostics?: Record<string, unknown>[] };
    traceWindow.__repolensGraphDiagnostics = [];
    let previous = "";
    const inspect = () => {
      const invalid = [...document.querySelectorAll(".react-flow__background pattern, .react-flow__background circle, .react-flow__viewport")]
        .map((element) => ({ tag: element.tagName, attributes: [...element.attributes].map((attribute) => [attribute.name, attribute.value]) }))
        .filter((element) => element.attributes.some(([, value]) => /NaN|Infinity/.test(value)));
      if (!invalid.length) return;
      const signature = JSON.stringify(invalid);
      if (signature === previous || traceWindow.__repolensGraphDiagnostics!.length >= 20) return;
      previous = signature;
      const rect = document.querySelector(".graph-canvas")?.getBoundingClientRect();
      traceWindow.__repolensGraphDiagnostics!.push({ invalid, canvas: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null, nodes: [...document.querySelectorAll(".react-flow__node")].map((node) => ({ id: node.getAttribute("data-id"), transform: (node as HTMLElement).style.transform, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })) });
    };
    const observer = new MutationObserver(inspect);
    const observe = () => { if (document.documentElement) observer.observe(document.documentElement, { attributes: true, attributeFilter: ["x", "y", "cx", "cy", "r", "transform"], childList: true, subtree: true }); };
    if (document.documentElement) observe(); else document.addEventListener("DOMContentLoaded", observe, { once: true });
    });
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(`${graphTestStage}: ${message.text()}`); });
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    graphTestStage = `${viewport.width}:goto`;
    await page.goto("/");
    graphTestStage = `${viewport.width}:select-step`;
    await page.getByRole("button", { name: "第 5 步：服务提供初始数据" }).click();
    if (viewport.width <= 860) { graphTestStage = `${viewport.width}:show-graph`; await page.getByRole("button", { name: "依赖图" }).click(); }
    const card = page.locator(".graph-file-card.is-selected");
    await expect(card).toBeVisible();
    expect(isGraphNodeWithinBounds(await waitForStableGraphGeometry(page), 24)).toBe(true);
    const activeStep = page.locator(".tour-step.is-current");
    await expect.poll(() => activeStep.evaluate((element) => {
      const step = element.getBoundingClientRect();
      const rail = element.parentElement!.getBoundingClientRect();
      return step.left >= rail.left - 1 && step.right <= rail.right + 1;
    })).toBe(true);
    graphTestStage = `${viewport.width}:reset-layout`;
    await page.getByRole("button", { name: "重置布局" }).click();
    expect(isGraphNodeWithinBounds(await waitForStableGraphGeometry(page), 24)).toBe(true);
    graphSnapshots.push(await page.evaluate(() => ({
      viewport: document.querySelector(".react-flow__viewport")?.getAttribute("transform"),
      viewportStyle: (document.querySelector(".react-flow__viewport") as HTMLElement | null)?.style.transform,
      background: [...(document.querySelector(".react-flow__background pattern")?.attributes ?? [])].map((attribute) => [attribute.name, attribute.value]),
      canvas: (() => { const rect = document.querySelector(".graph-canvas")?.getBoundingClientRect(); return rect ? { width: rect.width, height: rect.height } : null; })(),
    })));
    geometryErrors.push(...await page.evaluate(() => (window as Window & { __repolensGraphDiagnostics?: Record<string, unknown>[] }).__repolensGraphDiagnostics ?? []));
    await page.close();
  }
  if (consoleErrors.length || geometryErrors.length) console.log(`Browser console errors with graph geometry: ${JSON.stringify({ consoleErrors, geometryErrors, graphSnapshots })}`);
  expect(consoleErrors, "responsive graph must not emit browser console errors").toEqual([]);
  expect(geometryErrors, "responsive graph must keep finite SVG geometry").toEqual([]);
});

test("damaged progress falls back safely and unavailable localStorage uses the cookie fallback", async ({ browser }) => {
  const damaged = await browser.newPage();
  await damaged.addInitScript(() => localStorage.setItem("repolens:taskflow-sample:1.2", "{bad"));
  await damaged.goto("/");
  await expect(damaged.getByRole("button", { name: "第 1 步：从入口开始" })).toHaveAttribute("aria-current", "step");
  await expect(damaged.getByText("已忽略损坏的本地阅读进度。")).toBeVisible();
  await damaged.close();

  const cookieFallback = await browser.newPage();
  await cookieFallback.addInitScript(() => Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("storage disabled"); } }));
  await cookieFallback.goto("/");
  await cookieFallback.getByRole("button", { name: "第 3 步：列表拆分为组件" }).click();
  await cookieFallback.reload();
  await expect(cookieFallback.getByRole("button", { name: "第 3 步：列表拆分为组件" })).toHaveAttribute("aria-current", "step");
  await cookieFallback.close();
});

test("returning from a local repository restores the sample route progress", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-return-sample-"));
  await writeFile(path.join(repositoryPath, "main.ts"), "export const value = 1;\n");
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "第 3 步：列表拆分为组件" }).click();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    const openRepository = page.getByRole("button", { name: "打开仓库" });
    await expect(openRepository).toBeEnabled();
    await openRepository.click();
    await expect(page.getByText("本地仓库", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回示例" }).click();
    await expect(page.getByRole("button", { name: "第 3 步：列表拆分为组件" })).toHaveAttribute("aria-current", "step");
  } finally { await rm(repositoryPath, { recursive: true, force: true }); }
});

test("returning to the sample restores same-page progress when both storage backends are unavailable", async ({ page }) => {
  const repositoryPath = await mkdtemp(path.join(os.tmpdir(), "repolens-memory-progress-"));
  await writeFile(path.join(repositoryPath, "main.ts"), "export const value = 1;\n");
  try {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("storage disabled for recovery test"); } });
      Object.defineProperty(document, "cookie", { configurable: true, get() { return ""; }, set() {} });
    });
    await page.goto("/");
    const thirdStep = page.getByRole("button", { name: "第 3 步：列表拆分为组件" });
    await thirdStep.click();
    await expect(thirdStep).toHaveAttribute("aria-current", "step");
    await expect(page.getByText("浏览器存储不可用，本次阅读进度只保存在当前页面。", { exact: true })).toBeVisible();
    await page.getByLabel("本地仓库路径").fill(repositoryPath);
    await page.getByRole("button", { name: "打开仓库" }).click();
    await expect(page.getByText("本地仓库", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回示例" }).click();
    await expect(page.getByRole("button", { name: "第 3 步：列表拆分为组件" })).toHaveAttribute("aria-current", "step");
  } finally { await rm(repositoryPath, { recursive: true, force: true }); }
});

test("AI preview sends nothing before confirmation and stale generation cannot lock a new file", async ({ page }) => {
  modelCalls = 0;
  temporaryRepository = await mkdtemp(path.join(os.tmpdir(), "repolens-browser-ai-"));
  await writeFile(path.join(temporaryRepository, "main.ts"), 'import { value } from "./lib";\nexport const current = value;\n');
  await writeFile(path.join(temporaryRepository, "lib.ts"), "export const value = 1;\n");
  await page.goto("/");
  await expect(page.locator(".graph-file-card").first()).toBeVisible();
  const pathInput = page.getByLabel("本地仓库路径");
  await pathInput.fill(temporaryRepository);
  const openRepository = page.getByRole("button", { name: "打开仓库" });
  await expect(openRepository).toBeEnabled();
  await openRepository.click();
  await expect(page.getByText("本地仓库", { exact: true })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "main.ts" })).toBeVisible();

  await page.getByLabel("兼容服务地址").fill(modelOrigin);
  await page.getByLabel("模型名称").fill("mock-model");
  await page.getByLabel("API 密钥").fill("test-only-secret");
  await page.getByRole("button", { name: "保存本地配置" }).click();
  await expect(page.getByText("模型配置已保存在本地服务内存中。")).toBeVisible();
  await page.getByRole("button", { name: "生成当前文件讲解" }).click();
  await expect(page.getByText("发送前确认")).toBeVisible();
  expect(modelCalls).toBe(0);

  await page.getByRole("button", { name: "确认发送并生成" }).click();
  await expect.poll(() => modelCalls).toBe(1);
  await page.getByRole("treeitem", { name: "lib.ts" }).click();
  const generate = page.getByRole("button", { name: "生成当前文件讲解" });
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(page.getByText("发送前确认")).toBeVisible();
  await page.getByRole("button", { name: "确认发送并生成" }).click();
  await expect(page.getByText("mock response")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("lib.ts", { exact: true }).first()).toBeVisible();
  expect(modelCalls).toBe(2);

  await page.getByRole("button", { name: "生成阅读路线" }).click();
  await expect(page.getByText("发送前确认")).toBeVisible();
  await page.getByRole("button", { name: "确认发送并生成" }).click();
  await expect(page.getByRole("button", { name: "第 1 步：lib.ts" })).toBeVisible();
  await page.getByRole("tab", { name: "讲解" }).click();
  await writeFile(path.join(temporaryRepository, "unrelated.ts"), "export const unrelated = true;\n");
  await expect(page.getByText("本地索引已更新。")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("引用关联源码已变化，当前结果已过期，不能跳转。")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下一步" })).toBeEnabled();
  await writeFile(path.join(temporaryRepository, "lib.ts"), "export const value = 2;\n");
  await expect(page.getByText("引用关联源码已变化，当前结果已过期，不能跳转。")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "下一步" })).toBeDisabled();
  expect(modelCalls).toBe(3);
});
