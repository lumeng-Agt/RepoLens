import test from "node:test";
import assert from "node:assert/strict";
import { partialAnswer, readSseData } from "./ai-stream.mjs";
import { requestChatCompletion } from "./ai-generation.mjs";
import { AiStreamEventSchema } from "./ai-contract.mjs";

const context = { baseUrl: "https://model.example/v1", model: "mock", apiKey: "secret", question: "问题", mode: "question", entryFileId: "main.ts", revision: "r", sources: [] };
const frame = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const encode = (value) => new TextEncoder().encode(value);

test("answer extraction excludes nested fields, reasoning and incomplete escapes", () => {
  assert.equal(partialAnswer('{"reasoning":"secret","nested":{"answer":"fake"},"answer":"你好\\n世'), "你好\n世");
  assert.equal(partialAnswer('{"answer":"quote\\" slash\\\\\\u4f'), 'quote" slash\\');
  assert.equal(partialAnswer('{"answer":"\\uD83D'), "");
  assert.equal(partialAnswer('{"answer":"\\uD83D\\uDE00'), "😀");
  assert.equal(partialAnswer('{"reasoning":"answer"'), "");
});

test("SSE decodes Chinese split at every byte and ignores keepalives", async () => {
  const bytes = encode(':keepalive\r\ndata: {"text":"中文"}\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = [];
  for await (const data of readSseData(stream)) events.push(data);
  assert.deepEqual(events, ['{"text":"中文"}', "[DONE]"]);
});

test("real model deltas expose answer before completion, never raw JSON or reasoning", async () => {
  let finish; let first;
  const firstText = new Promise((resolve) => { first = resolve; });
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(encode(frame('{"reasoning":"private","answer":"第一段')));
    finish = () => { controller.enqueue(encode(frame('，第二段","references":[],"insufficientEvidence":true}') + 'data: [DONE]\n\n')); controller.close(); };
  } });
  let settled = false; const texts = [];
  const result = requestChatCompletion(context, "question", undefined, false, async (_url, init) => { assert.equal(JSON.parse(init.body).stream, true); assert.equal(init.redirect, "manual"); return new Response(stream, { headers: { "Content-Type": "text/event-stream" } }); }, { stream: true, onAnswer: (value) => { texts.push(value); first(); } }).then((value) => { settled = true; return value; });
  await firstText;
  assert.equal(settled, false); assert.deepEqual(texts, ["第一段"]);
  finish();
  assert.equal((await result).answer, "第一段，第二段");
  assert.equal(texts.some((text) => text.includes("private") || text.includes("references")), false);
});

test("stream truncation and malformed packets fail instead of accepting partial answers", async () => {
  for (const content of [frame('{"answer":"partial'), 'data: not-json\n\n']) {
    const response = new Response(content, { headers: { "Content-Type": "text/event-stream" } });
    await assert.rejects(requestChatCompletion(context, "question", undefined, false, async () => response, { stream: true }), /中断|格式/);
  }
});

test("JSON-only services work once and unsupported streams never retry automatically", async () => {
  let calls = 0;
  const output = { answer: "完整回答", references: [], insufficientEvidence: true };
  const result = await requestChatCompletion(context, "question", undefined, false, async () => { calls++; return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }); }, { stream: true });
  assert.deepEqual(result, output); assert.equal(calls, 1);
  await assert.rejects(requestChatCompletion(context, "question", undefined, false, async () => { calls++; return new Response("stream unsupported", { status: 400 }); }, { stream: true }), { code: "STREAM_UNSUPPORTED" });
  assert.equal(calls, 2);
});

test("stream contracts require completion data and reject incomplete event shapes", () => {
  const identity = { requestId: "p", repositoryId: "repo", revision: "r" };
  assert.equal(AiStreamEventSchema.safeParse({ ...identity, type: "complete" }).success, false);
  assert.equal(AiStreamEventSchema.safeParse({ ...identity, type: "text", text: "你好" }).success, true);
  assert.equal(AiStreamEventSchema.safeParse({ ...identity, type: "status", status: "repairing" }).success, true);
});
