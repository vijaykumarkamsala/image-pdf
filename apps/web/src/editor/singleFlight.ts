export class SingleFlight<T> {
  private active: Promise<T> | null = null;

  run(operation: () => Promise<T>): Promise<T> {
    if (this.active) return this.active;
    const current = Promise.resolve().then(operation);
    this.active = current;
    void current.finally(() => {
      if (this.active === current) this.active = null;
    }).catch(() => undefined);
    return current;
  }

  get inFlight(): boolean {
    return this.active !== null;
  }
}
