import { Inject, Injectable } from "@nestjs/common";

import { RUNTIME_VALUES } from "../../kernel/product.types.js";
import type { RuntimeValues } from "../../kernel/runtime.js";
import { JOB_DISPATCH_QUEUE, type JobDispatchQueue } from "./dispatch.js";
import { DURABLE_JOB_REPOSITORY, type DurableJobRepository } from "./durable-job.types.js";

@Injectable()
export class OutboxDispatcher {
  constructor(
    @Inject(DURABLE_JOB_REPOSITORY) private readonly repository: DurableJobRepository,
    @Inject(JOB_DISPATCH_QUEUE) private readonly queue: JobDispatchQueue,
    @Inject(RUNTIME_VALUES) private readonly runtime: RuntimeValues,
  ) {}

  async dispatchOnce(limit = 20): Promise<number> {
    const pending = await this.repository.pendingOutbox(this.runtime.now(), limit);
    for (const item of pending) {
      await this.queue.enqueue({ dispatchId: item.outboxId, jobId: item.jobId, kind: "process_job" });
      await this.repository.markOutboxDispatched(item.outboxId, this.runtime.now());
    }
    return pending.length;
  }
}
