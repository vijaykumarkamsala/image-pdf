import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";

import { LocalInspectionExecutor } from "./local-inspection-executor.js";
import { OutboxDispatcher } from "./outbox-dispatcher.js";

/** Development-only background pump. Production uses separately deployed relay and worker processes. */
@Injectable()
export class LocalJobRuntime implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly executor: LocalInspectionExecutor,
  ) {}

  onModuleInit(): void {
    if (process.env["NODE_ENV"] === "production" || process.env["NODE_ENV"] === "test") return;
    this.timer = setInterval(() => void this.tick(), 100);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatcher.dispatchOnce();
      await this.executor.runAvailable();
    } finally {
      this.running = false;
    }
  }
}
