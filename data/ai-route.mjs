function routeContent(title, steps) {
  return {
    title: String(title),
    steps: steps.map((step) => ({
      fileId: step.fileId,
      purpose: step.purpose,
      references: [...step.references]
        .map((reference) => ({ fileId: reference.fileId, startLine: reference.startLine, endLine: reference.endLine ?? null }))
        .sort((left, right) => left.fileId.localeCompare(right.fileId) || left.startLine - right.startLine || (left.endLine ?? 0) - (right.endLine ?? 0)),
    })),
  };
}

export function aiRouteSignature(title, steps) {
  const value = JSON.stringify(routeContent(title, steps));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

export function createAiRouteRecord(input, fileNameFor = (fileId) => fileId) {
  const sourceSteps = routeContent(input.title, input.steps).steps;
  const signature = aiRouteSignature(input.title, sourceSteps);
  const steps = sourceSteps.map((step, index) => {
    const reference = step.references.find((item) => item.fileId === step.fileId);
    if (!reference) throw new Error(`阅读路线第 ${index + 1} 步缺少对应文件引用。`);
    return {
      id: `ai-${signature}-${index}`,
      title: fileNameFor(step.fileId),
      focusFileId: step.fileId,
      description: step.purpose,
      reference: { fileId: reference.fileId, line: reference.startLine, ...(reference.endLine ? { endLine: reference.endLine } : {}) },
    };
  });
  return { ...input, signature, sourceSteps, steps };
}
