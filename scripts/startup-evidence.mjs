import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

export async function preserveFailureEvidence({ title, status, errors = [], attachments = [], serverLogPath, destinationRoot = path.join(os.tmpdir(), 'repolens-startup-evidence') }) {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const destination = path.join(destinationRoot, runId);
  await mkdir(destination, { recursive: true });
  const files = [];

  for (const [index, attachment] of attachments.entries()) {
    let filename = safeFilename(attachment.name ?? `attachment-${index + 1}`);
    if (!path.extname(filename) && attachment.path) filename += path.extname(attachment.path);
    if (!path.extname(filename) && attachment.contentType === 'image/png') filename += '.png';
    if (!path.extname(filename) && attachment.contentType === 'application/zip') filename += '.zip';
    if (attachment.path) await copyFile(attachment.path, path.join(destination, filename));
    else if (attachment.body) await writeFile(path.join(destination, filename), attachment.body);
    else continue;
    files.push(filename);
  }

  if (serverLogPath) {
    try {
      await copyFile(serverLogPath, path.join(destination, 'service.log'));
      files.push('service.log');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  await writeFile(path.join(destination, 'failure.json'), JSON.stringify({
    title,
    status,
    errors: errors.map((error) => ({ message: error.message, stack: error.stack })),
    preservedFiles: files,
  }, null, 2));
  return { destination, files };
}
