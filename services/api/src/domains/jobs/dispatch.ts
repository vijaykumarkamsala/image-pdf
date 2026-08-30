export interface JobDispatchMessage {
  dispatchId: string;
  jobId: string;
  kind: "process_job";
}

export interface JobDispatchQueue {
  enqueue(message: JobDispatchMessage): Promise<void>;
}

export class LocalJobDispatchQueue implements JobDispatchQueue {
  private readonly messages = new Map<string, JobDispatchMessage>();

  async enqueue(message: JobDispatchMessage): Promise<void> {
    this.messages.set(message.dispatchId, message);
  }

  pending(): JobDispatchMessage[] {
    return [...this.messages.values()];
  }
}

export interface CloudTasksClient {
  createHttpTask(input: {
    taskName: string;
    endpoint: string;
    audience: string;
    body: JobDispatchMessage;
  }): Promise<void>;
}

export class CloudTasksJobDispatchQueue implements JobDispatchQueue {
  constructor(
    private readonly client: CloudTasksClient,
    private readonly endpoint: string,
    private readonly audience: string,
  ) {}

  enqueue(message: JobDispatchMessage): Promise<void> {
    return this.client.createHttpTask({
      taskName: message.dispatchId,
      endpoint: this.endpoint,
      audience: this.audience,
      body: message,
    });
  }
}

export const JOB_DISPATCH_QUEUE = Symbol("JOB_DISPATCH_QUEUE");
