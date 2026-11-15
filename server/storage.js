import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";

const PREFIX = "terralens:v1";
const GLOBAL_GENERATION_KEY = `${PREFIX}:generation-slots`;
const GENERATION_TTL_MS = 90_000;

export class StorageUnavailableError extends Error {
  constructor() {
    super(
      "Shared assistant storage is unavailable. Check the Upstash Redis environment variables and connection.",
    );
    this.name = "StorageUnavailableError";
    this.code = "STORAGE_UNAVAILABLE";
    this.status = 503;
  }
}

function packDataset(record) {
  return {
    ...record,
    views: [...record.views],
    histories: [...record.histories],
    answers: [...record.answers],
  };
}

function unpackDataset(record) {
  if (!record) return null;
  return {
    ...record,
    views: new Map(record.views || []),
    histories: new Map(record.histories || []),
    answers: new Map(record.answers || []),
  };
}

function rateKey(identifier) {
  return `${PREFIX}:rate:${createHash("sha256").update(identifier).digest("hex")}`;
}

export class MemoryAssistantStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.sessions = new Map();
    this.datasets = new Map();
    this.ownerDatasets = new Map();
    this.rates = new Map();
    this.generations = new Map();
    this.activeGenerationTokens = new Set();
    this.shared = false;
  }

  async health() {
    return true;
  }

  async getSession(id) {
    const item = this.sessions.get(id);
    if (!item || item.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return null;
    }
    return item;
  }

  async setSession(id, value, ttlSeconds) {
    this.sessions.set(id, {
      ...value,
      expiresAt: Math.min(value.expiresAt, this.now() + ttlSeconds * 1000),
    });
  }

  async getDataset(id) {
    const item = this.datasets.get(id);
    if (!item || item.expiresAt <= this.now()) {
      await this.deleteDataset(id);
      return null;
    }
    return unpackDataset(packDataset(item));
  }

  async setDataset(record, ttlSeconds) {
    this.datasets.set(record.id, unpackDataset(packDataset(record)));
    if (record.owner) await this.addDatasetId(record.owner, record.id, ttlSeconds);
  }

  async deleteDataset(id) {
    const item = this.datasets.get(id);
    this.datasets.delete(id);
    if (item?.owner) await this.removeDatasetId(item.owner, id);
  }

  async getDatasetIds(owner) {
    return [...(this.ownerDatasets.get(owner) || [])];
  }

  async addDatasetId(owner, id) {
    if (!this.ownerDatasets.has(owner)) this.ownerDatasets.set(owner, new Set());
    this.ownerDatasets.get(owner).add(id);
  }

  async removeDatasetId(owner, id) {
    const ids = this.ownerDatasets.get(owner);
    ids?.delete(id);
    if (ids?.size === 0) this.ownerDatasets.delete(owner);
  }

  async incrementRate(identifier, ttlSeconds) {
    const key = rateKey(identifier),
      current = this.rates.get(key),
      time = this.now();
    if (!current || current.expiresAt <= time) {
      this.rates.set(key, { count: 1, expiresAt: time + ttlSeconds * 1000 });
      return 1;
    }
    current.count++;
    return current.count;
  }

  async acquireGeneration(datasetId, token, maxConcurrent = 2) {
    const time = this.now();
    for (const [key, generation] of this.generations)
      if (generation.expiresAt <= time) this.generations.delete(key);
    if (this.generations.has(datasetId) || this.generations.size >= maxConcurrent)
      return false;
    const generation = { token, expiresAt: time + GENERATION_TTL_MS };
    this.generations.set(datasetId, generation);
    this.activeGenerationTokens.add(token);
    return true;
  }

  async releaseGeneration(datasetId, token) {
    if (this.generations.get(datasetId)?.token === token)
      this.generations.delete(datasetId);
    this.activeGenerationTokens.delete(token);
  }
}

const ACQUIRE_GENERATION = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local token = ARGV[3]
local maxConcurrent = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('ZCARD', KEYS[1]) >= maxConcurrent then return 0 end
redis.call('ZADD', KEYS[1], now + ttl, token)
redis.call('SET', KEYS[2], token, 'PX', ttl)
redis.call('PEXPIRE', KEYS[1], ttl)
return 1
`;

const RELEASE_GENERATION = `
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
redis.call('ZREM', KEYS[1], ARGV[1])
return 1
`;

export class RedisAssistantStore {
  constructor(redis) {
    this.redis = redis;
    this.shared = true;
  }

  async health() {
    return (await this.redis.ping()) === "PONG";
  }

  key(...parts) {
    return `${PREFIX}:${parts.join(":")}`;
  }

  async getSession(id) {
    const item = await this.redis.get(this.key("session", id));
    return item?.expiresAt > Date.now() ? item : null;
  }

  async setSession(id, value, ttlSeconds) {
    await this.redis.set(this.key("session", id), value, { ex: ttlSeconds });
  }

  async getDataset(id) {
    const item = await this.redis.get(this.key("dataset", id));
    if (!item || item.expiresAt <= Date.now()) return null;
    return unpackDataset(item);
  }

  async setDataset(record, ttlSeconds) {
    await this.redis.set(this.key("dataset", record.id), packDataset(record), {
      ex: ttlSeconds,
    });
    await this.redis.sadd(this.key("owner-datasets", record.owner), record.id);
    await this.redis.expire(this.key("owner-datasets", record.owner), ttlSeconds);
  }

  async deleteDataset(id) {
    const key = this.key("dataset", id),
      record = await this.redis.get(key);
    await this.redis.del(key);
    if (record?.owner)
      await this.removeDatasetId(record.owner, id);
  }

  async getDatasetIds(owner) {
    return this.redis.smembers(this.key("owner-datasets", owner));
  }

  async addDatasetId(owner, id, ttlSeconds) {
    const key = this.key("owner-datasets", owner);
    await this.redis.sadd(key, id);
    await this.redis.expire(key, ttlSeconds);
  }

  async removeDatasetId(owner, id) {
    await this.redis.srem(this.key("owner-datasets", owner), id);
  }

  async incrementRate(identifier, ttlSeconds) {
    const key = rateKey(identifier);
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttlSeconds);
    return count;
  }

  async acquireGeneration(datasetId, token, maxConcurrent = 2) {
    const result = await this.redis.eval(
      ACQUIRE_GENERATION,
      [GLOBAL_GENERATION_KEY, this.key("generation", datasetId)],
      [Date.now(), GENERATION_TTL_MS, token, maxConcurrent],
    );
    return Number(result) === 1;
  }

  async releaseGeneration(datasetId, token) {
    await this.redis.eval(
      RELEASE_GENERATION,
      [GLOBAL_GENERATION_KEY, this.key("generation", datasetId)],
      [token],
    );
  }
}

class UnavailableAssistantStore {
  constructor() {
    this.shared = false;
  }

  async health() {
    return false;
  }

  async unavailable() {
    throw new StorageUnavailableError();
  }
}

for (const method of [
  "getSession",
  "setSession",
  "getDataset",
  "setDataset",
  "deleteDataset",
  "getDatasetIds",
  "addDatasetId",
  "removeDatasetId",
  "incrementRate",
  "acquireGeneration",
  "releaseGeneration",
])
  UnavailableAssistantStore.prototype[method] =
    UnavailableAssistantStore.prototype.unavailable;

export function createAssistantStore({
  config = {},
  env = process.env,
  redisClient,
  requireShared = false,
  now,
} = {}) {
  const url = config.redisUrl || env.UPSTASH_REDIS_REST_URL,
    token = config.redisToken || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token)
    return new RedisAssistantStore(
      redisClient || new Redis({ url, token }),
    );
  if (url || token || requireShared) return new UnavailableAssistantStore();
  return new MemoryAssistantStore({ now });
}
