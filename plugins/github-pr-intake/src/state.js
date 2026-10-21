import { MAX_DEBOUNCE_SECONDS, STATE_NAMESPACE } from "./constants.js";

const MAX_DELIVERIES = 500;
const MAX_DEBOUNCE_MS = MAX_DEBOUNCE_SECONDS * 1000;

const scope = (stateKey) => ({ scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey });

/** Persistent state for the intake worker. Index updates are serialized (read-modify-write). */
export function createStore(ctx) {
  let tail = Promise.resolve();
  const exclusive = (operation) => {
    const run = tail.catch(() => {}).then(operation);
    tail = run;
    return run;
  };
  const read = async (key) => (await ctx.state.get(scope(key))) ?? null;
  const write = (key, value) => ctx.state.set(scope(key), value);
  const remove = (key) => ctx.state.delete(scope(key));

  const addToIndex = (indexKey, key) =>
    exclusive(async () => {
      const index = (await read(indexKey)) ?? [];
      if (!index.includes(key)) await write(indexKey, [...index, key]);
    });
  const removeFromIndex = (indexKey, key) =>
    exclusive(async () => {
      const index = (await read(indexKey)) ?? [];
      if (index.includes(key)) await write(indexKey, index.filter((item) => item !== key));
    });

  return {
    /** @returns {Promise<boolean>} true the first time a delivery id is seen */
    markDeliverySeen: (deliveryId) =>
      exclusive(async () => {
        const seen = (await read("deliveries")) ?? [];
        if (seen.includes(deliveryId)) return false;
        await write("deliveries", [...seen, deliveryId].slice(-MAX_DELIVERIES));
        return true;
      }),

    getPr: (key) => read(`pr:${key}`),
    async savePr(key, record) {
      await write(`pr:${key}`, record);
      await addToIndex("pr-index", key);
    },
    prKeys: async () => (await read("pr-index")) ?? [],

    getQueue: (key) => read(`queue:${key}`),
    queueKeys: async () => (await read("queue-index")) ?? [],
    /** Coalesces repeated pushes: keeps the first-queued time and caps how far dueAt may slide. */
    async enqueue(key, entry) {
      const prior = await read(`queue:${key}`);
      const firstQueuedAt = prior?.firstQueuedAt ?? entry.dueAt;
      await write(`queue:${key}`, {
        ...entry,
        firstQueuedAt,
        attempts: prior?.attempts ?? 0,
        dueAt: Math.min(entry.dueAt, firstQueuedAt + MAX_DEBOUNCE_MS),
      });
      await addToIndex("queue-index", key);
    },
    async retryLater(key, entry, dueAt) {
      await write(`queue:${key}`, { ...entry, attempts: (entry.attempts ?? 0) + 1, dueAt });
    },
    async dequeue(key) {
      await remove(`queue:${key}`);
      await removeFromIndex("queue-index", key);
    },

    getEtag: (repoKey) => read(`etag:${repoKey}`),
    setEtag: (repoKey, etag) => write(`etag:${repoKey}`, etag),
  };
}
