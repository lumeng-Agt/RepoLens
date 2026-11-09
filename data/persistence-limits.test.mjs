import test from "node:test";
import assert from "node:assert/strict";
import { assertBoundedData, serializeWorkspaceMutation, assertReadingArtifactCapacity } from "./persistence-limits.mjs";

test("reading artifact preflight rejects merged counts before mutation and keeps unknown legal fields", () => {
  const tours = Array.from({ length: 99 }, (_, i) => ({ signature: String(i) }));
  const original = structuredClone(tours);
  assert.throws(() => assertReadingArtifactCapacity({ tours: [...tours, {signature: "a"}, {signature: "b"}] }), /100/);
  assert.deepEqual(tours, original);
  assert.throws(() => assertReadingArtifactCapacity({ notes: Array(10001).fill({}) }), /10,000/);
  const value = { action: "reading-notes", notes: [{ future: { field: ["中文"] } }] };
  assert.deepEqual(JSON.parse(serializeWorkspaceMutation(value)), value);
});

test("workspace limits count UTF-8 request envelope bytes and reject deep or cyclic extras before serialization", () => {
  assert.throws(() => serializeWorkspaceMutation({action: "reading-notes", notes: [{text: "中".repeat(670000)}]}), /2 MB/);
  let future = {};
  for (let i = 0; i < 12000; i++) future = { future };
  assert.throws(() => assertBoundedData({ future }), /层级/);
  const circular = {}; circular.self = circular;
  assert.throws(() => assertBoundedData(circular), /循环/);
  assert.throws(() => assertBoundedData(Array.from({length: 200001}, () => 1)), /复杂/);
});


test("request envelope bytes are included and shared non-cyclic extension values remain legal", () => {
  const shared = { future: "kept" };
  assert.doesNotThrow(() => assertBoundedData([shared, shared]));
  const notes = [{ text: "x".repeat(1999900) }];
  assert.doesNotThrow(() => assertReadingArtifactCapacity({ notes }));
  assert.throws(() => assertReadingArtifactCapacity({ notes }, { repositoryId: "r".repeat(160), workspaceId: "w".repeat(200) }), /2 MB/);
});
