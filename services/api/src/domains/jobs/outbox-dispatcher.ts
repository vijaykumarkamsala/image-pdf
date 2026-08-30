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
    const workerId = this.runtime.id("outbox-relay");
    const now = this.runtime.now();
    const pending = await this.repository.claimOutbox(workerId, now, this.after(now, 30), limit);
    let dispatched = 0;
    for (const item of pending) {
      try {
        await this.queue.enqueue({
          dispatchId: item.outboxId,
          jobId: item.jobId,
          traceId: item.traceId,
          kind: "process_job",
        });
        await this.repository.markOutboxDispatched(item.outboxId, workerId, this.runtime.now());
        dispatched += 1;
      } catch {
        await this.repository.releaseOutbox(
          item.outboxId,
          workerId,
          this.after(this.runtime.now(), Math.min(300, 2 ** Math.min(item.deliveryAttempts, 8))),
          "provider-unavailable",
        );
      }
    }
    return dispatched;
  }

  private after(now: string, seconds: number): string {
    return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
  }
}
