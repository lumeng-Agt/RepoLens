import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AI_PROMPT_VERSION, buildChatCompletionRequest, requestChatCompletion, validateAiResult } from "./ai-generation.mjs";

const context = {
  baseUrl: "https://model.example/v1/",
  model: "test-model",
  apiKey: "secret",
  revision: "rev-1",
  entryFileId: "src/b.ts",
  mode: "explanation",
  sources: [
    { fileId: "src/a.ts", source: "export const a = 1;", startLine: 2, endLine: 2 },
    { fileId: "src/b.ts", source: "import { a } from './a';", startLine: 1, endLine: 1 },
  ],
};

test("chat request names the selected entry and shares a prompt version", () => {
  const { url, body } = buildChatCompletionRequest(context, "explanation");
  assert.equal(url, "https://model.example/v1/chat/completions");
  assert.match(body.messages[1].content, new RegExp(`\\"promptVersion\\":\\"${AI_PROMPT_VERSION}\\"`));
  assert.match(body.messages[1].content, /入口文件 src\/b\.ts/);
  assert.doesNotMatch(body.messages[1].content, /入口文件 src\/a\.ts/);
});

test("route task instructs the model to begin at the selected file", () => {
  const { body } = buildChatCompletionRequest({ ...context, entryFileId: "src/a.ts", goal: "理解数据保存流程" }, "route", true);
  assert.match(body.messages[1].content, /第一步的 fileId 必须是该入口/);
  assert.match(body.messages[1].content, /src\/a\.ts/);
  assert.match(body.messages[1].content, /理解数据保存流程/);
  assert.match(body.messages[1].content, /question/);
  assert.match(body.messages[1].content, /relationship/);
  assert.match(body.messages[1].content, /上一次输出没有满足格式/);
});

test("AI citations must belong to selected files and approved line ranges", () => {
  const good = { role: "入口说明", keyPoints: [], references: [{ fileId: "src/b.ts", startLine: 1 }] };
  assert.deepEqual(validateAiResult(good, context), good);
  assert.throws(() => validateAiResult({ ...good, references: [{ fileId: "src/a.ts", startLine: 1 }] }, context), /必须引用所选入口/);
  assert.throws(() => validateAiResult({ ...good, references: [{ fileId: "src/b.ts", startLine: 2 }] }, context), /行号无效/);
});

test("route validation requires the selected entry as the first step and per-step citations", () => {
  const routeContext = { ...context, mode: "route", sources: context.sources.map((source) => ({ ...source, startLine: 1, endLine: 10 })) };
  const route = { title: "路线", steps: [
    { fileId: "src/b.ts", purpose: "入口", relationship: "选定入口", question: "入口提供了什么？", references: [{ fileId: "src/b.ts", startLine: 1 }] },
    { fileId: "src/a.ts", purpose: "依赖", relationship: "继续阅读静态依赖", question: "依赖提供了什么？", references: [{ fileId: "src/a.ts", startLine: 1 }] },
    { fileId: "src/b.ts", purpose: "回看", relationship: "回到入口核对", question: "数据如何返回入口？", references: [{ fileId: "src/b.ts", startLine: 1 }] },
  ] };
  assert.deepEqual(validateAiResult(route, routeContext), route);
  assert.throws(() => validateAiResult({ ...route, steps: [{ ...route.steps[0], fileId: "src/a.ts" }, ...route.steps.slice(1)] }, routeContext), /第一步必须/);
  assert.throws(() => validateAiResult({ ...route, steps: [{ ...route.steps[0], references: [{ fileId: "src/a.ts", startLine: 1 }] }, ...route.steps.slice(1)] }, routeContext), /必须引用本步骤/);
});

test("mockable Chat Completions client preserves abort signal and parses JSON", async () => {
  const controller = new AbortController();
  let captured;
  const result = await requestChatCompletion(context, "explanation", controller.signal, false, async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ choices: [{ message: { content: "{\"ok\":true}" } }] }) };
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.url, "https://model.example/v1/chat/completions");
  assert.equal(captured.options.signal, controller.signal);
  assert.equal(captured.options.headers.Authorization, "Bearer secret");
  assert.equal(captured.options.redirect, "manual");
});

test("chat completion rejects every redirect without contacting its target", async (testContext) => {
  let targetRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
  });
  const targetPort = await new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => resolve(target.address().port));
  });
  const redirector = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/target/")) {
      targetRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));
      return;
    }
    const status = Number(url.searchParams.get("status"));
    const targetKind = url.searchParams.get("target");
    const location = targetKind === "same-origin"
      ? `http://127.0.0.1:${redirector.address().port}/target/${status}`
      : targetKind === "cross-port"
        ? `http://127.0.0.1:${targetPort}/target/${status}`
        : `http://localhost:${targetPort}/target/${status}`;
    response.writeHead(status, { Location: location });
    response.end();
  });
  const redirectorPort = await new Promise((resolve, reject) => {
    redirector.once("error", reject);
    redirector.listen(0, "127.0.0.1", () => resolve(redirector.address().port));
  });
  testContext.after(async () => {
    await Promise.all([redirector, target].map((server) => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    })));
  });

  for (const status of [301, 302, 303, 307, 308]) {
    for (const targetKind of ["same-origin", "cross-port", "cross-host"]) {
      await assert.rejects(
        requestChatCompletion({ ...context, baseUrl: `http://127.0.0.1:${redirectorPort}/v1?status=${status}&target=${targetKind}` }, "explanation"),
        (error) => error.code === "MODEL_REDIRECT",
        `${status} ${targetKind} redirect must be rejected`,
      );
      assert.equal(targetRequests, 0, `${status} ${targetKind} target must receive no request`);
    }
  }
});
