/**
 * Shared usage snapshot store: Settings refresh and the composer pill
 * must see one in-flight fetch and one mode per provider.
 *
 * client/factory.js inlines the same control flow (ModuleLoader cannot
 * import this module). Keep the two aligned.
 */

export type UsageSnapshot = { mode?: string } & Record<string, unknown>;

type PendingJob<T> = {
  force: boolean;
  promise: Promise<T>;
};

export type UsageReader<T> = (force: boolean, provider: string) => Promise<T>;

export function createUsageSyncStore<T extends UsageSnapshot>(readUsage: UsageReader<T>) {
  const subs = new Set<(provider: string, snap: T | undefined) => void>();
  const byProvider = Object.create(null) as Record<string, T>;
  const pending = Object.create(null) as Record<string, PendingJob<T>>;

  const notify = (provider: string) => {
    const snap = byProvider[provider];
    for (const fn of subs) fn(provider, snap);
  };

  const fetchShared = (force: boolean, provider: string): Promise<T> => {
    const inflight = pending[provider];
    if (inflight) {
      if (force && !inflight.force) {
        const follow: PendingJob<T> = { force: true, promise: Promise.resolve(undefined as unknown as T) };
        follow.promise = inflight.promise.then(
          () => {
            if (pending[provider] === follow) delete pending[provider];
            return fetchShared(true, provider);
          },
          () => {
            if (pending[provider] === follow) delete pending[provider];
            return fetchShared(true, provider);
          },
        );
        pending[provider] = follow;
        return follow.promise;
      }
      return inflight.promise;
    }
    const job: PendingJob<T> = { force: Boolean(force), promise: Promise.resolve(undefined as unknown as T) };
    job.promise = readUsage(job.force, provider).then(
      (next) => {
        if (pending[provider] === job) delete pending[provider];
        byProvider[provider] = next;
        notify(provider);
        return next;
      },
      (cause) => {
        if (pending[provider] === job) delete pending[provider];
        throw cause;
      },
    );
    pending[provider] = job;
    return job.promise;
  };

  const applyMode = (mode: string) => {
    for (const provider of Object.keys(byProvider)) {
      const prev = byProvider[provider];
      byProvider[provider] = { ...prev, mode };
      notify(provider);
    }
  };

  const applySnapshot = (provider: string, patch: Partial<T>) => {
    const prev = byProvider[provider];
    byProvider[provider] = (prev ? { ...prev, ...patch } : { ...patch }) as T;
    notify(provider);
  };

  return {
    subscribe(fn: (provider: string, snap: T | undefined) => void) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    snapshot(provider: string) {
      return byProvider[provider];
    },
    fetch: fetchShared,
    applyMode,
    applySnapshot,
    /** Test hook: whether a provider currently has an in-flight job marked force. */
    pendingForce(provider: string) {
      return pending[provider]?.force;
    },
  };
}
