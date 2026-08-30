import { CloudTasksClient, protos } from "@google-cloud/tasks";

import type { CloudTasksProviderClient, JobDispatchQueue } from "./dispatch.js";
import { CloudTasksJobDispatchQueue, LocalJobDispatchQueue } from "./dispatch.js";

interface GoogleApiError extends Error {
  code?: number;
}

export interface CloudTasksConfig {
  projectId: string;
  location: string;
  queue: string;
  targetUrl: string;
  audience: string;
  serviceAccountEmail: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required in production`);
  return value;
}

function httpsUrl(value: string, name: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${name} must be a protected HTTPS URL without credentials or fragments`);
  }
  return parsed.toString();
}

export function loadCloudTasksConfig(env: NodeJS.ProcessEnv): CloudTasksConfig {
  const config = {
    projectId: required(env, "IPW_GCP_PROJECT_ID"),
    location: required(env, "IPW_CLOUD_TASKS_LOCATION"),
    queue: required(env, "IPW_CLOUD_TASKS_QUEUE"),
    targetUrl: httpsUrl(required(env, "IPW_WORKER_TASK_URL"), "IPW_WORKER_TASK_URL"),
    audience: httpsUrl(required(env, "IPW_WORKER_OIDC_AUDIENCE"), "IPW_WORKER_OIDC_AUDIENCE"),
    serviceAccountEmail: required(env, "IPW_CLOUD_TASKS_SERVICE_ACCOUNT"),
  };
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)) throw new Error("IPW_GCP_PROJECT_ID is invalid");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.location)) throw new Error("IPW_CLOUD_TASKS_LOCATION is invalid");
  if (!/^[a-z][a-z0-9-]{0,98}[a-z0-9]$/.test(config.queue)) throw new Error("IPW_CLOUD_TASKS_QUEUE is invalid");
  if (!/^[a-z0-9][a-z0-9._-]{2,62}@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(config.serviceAccountEmail)) {
    throw new Error("IPW_CLOUD_TASKS_SERVICE_ACCOUNT is invalid");
  }
  return config;
}

export class GoogleCloudTasksProviderClient implements CloudTasksProviderClient {
  private readonly parent: string;

  constructor(
    private readonly config: CloudTasksConfig,
    private readonly client: CloudTasksClient = new CloudTasksClient(),
  ) {
    this.parent = client.queuePath(config.projectId, config.location, config.queue);
  }

  async createHttpTask(input: {
    taskName: string;
    endpoint: string;
    audience: string;
    serviceAccountEmail: string;
    body: { dispatchId: string; jobId: string; traceId: string; kind: "process_job" };
  }): Promise<void> {
    const name = this.client.taskPath(
      this.config.projectId,
      this.config.location,
      this.config.queue,
      input.taskName,
    );
    try {
      await this.client.createTask({
        parent: this.parent,
        task: {
          name,
          httpRequest: {
            httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
            url: input.endpoint,
            headers: { "Content-Type": "application/json" },
            body: Buffer.from(JSON.stringify(input.body), "utf8"),
            oidcToken: {
              serviceAccountEmail: input.serviceAccountEmail,
              audience: input.audience,
            },
          },
        },
      });
    } catch (error) {
      if ((error as GoogleApiError).code !== 6) throw error;
    }
  }
}

export function createJobDispatchQueue(
  env: NodeJS.ProcessEnv,
  providerClient?: CloudTasksProviderClient,
): JobDispatchQueue {
  if (env["NODE_ENV"] !== "production") return new LocalJobDispatchQueue();
  const config = loadCloudTasksConfig(env);
  return new CloudTasksJobDispatchQueue(
    providerClient ?? new GoogleCloudTasksProviderClient(config),
    config.targetUrl,
    config.audience,
    config.serviceAccountEmail,
  );
}
