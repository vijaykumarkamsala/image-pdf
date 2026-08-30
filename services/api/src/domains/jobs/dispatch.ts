export interface JobDispatchMessage {
  dispatchId: string;
  jobId: string;
  traceId: string;
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

export interface CloudTasksProviderClient {
  createHttpTask(input: {
    taskName: string;
    endpoint: string;
    audience: string;
    serviceAccountEmail: string;
    body: JobDispatchMessage;
  }): Promise<void>;
}

export class CloudTasksJobDispatchQueue implements JobDispatchQueue {
  constructor(
    private readonly client: CloudTasksProviderClient,
    private readonly endpoint: string,
    private readonly audience: string,
    private readonly serviceAccountEmail: string,
  ) {}

  enqueue(message: JobDispatchMessage): Promise<void> {
    return this.client.createHttpTask({
      taskName: message.dispatchId,
      endpoint: this.endpoint,
      audience: this.audience,
      serviceAccountEmail: this.serviceAccountEmail,
      body: message,
    });
  }
}

export const JOB_DISPATCH_QUEUE = Symbol("JOB_DISPATCH_QUEUE");
