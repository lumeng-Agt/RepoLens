export type FailureAttachment = {
  name: string;
  path?: string;
  body?: Buffer | string;
  contentType?: string;
};

export function preserveFailureEvidence(input: {
  title: string;
  status: string;
  errors?: Array<{ message?: string; stack?: string }>;
  attachments?: FailureAttachment[];
  serverLogPath?: string;
  destinationRoot?: string;
}): Promise<{ destination: string; files: string[] }>;
