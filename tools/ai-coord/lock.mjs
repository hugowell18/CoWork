#!/usr/bin/env node
import { promises as fs } from "node:fs";
import {
  appendLog,
  ensureCoordDirs,
  isLockExpired,
  lockFileFor,
  nowIso,
  parseArgs,
  readJson,
  requireArg,
  writeJson
} from "./lib/core.mjs";

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

function usage() {
  console.log("用法：");
  console.log("  node tools/ai-coord/lock.mjs claim --agent <agent> --resource <resource> [--ttl-minutes 120] [--reason text]");
  console.log("  node tools/ai-coord/lock.mjs release --agent <agent> --resource <resource>");
}

await ensureCoordDirs();

if (!command || !["claim", "release"].includes(command)) {
  usage();
  process.exit(1);
}

const agent = requireArg(args, "agent");
const resource = requireArg(args, "resource");
const filePath = lockFileFor(resource);

if (command === "claim") {
  const ttlMinutes = Number(args["ttl-minutes"] ?? 120);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new Error("--ttl-minutes 必须是正数");
  }

  try {
    const existing = await readJson(filePath);
    if (!isLockExpired(existing) && existing.owner !== agent) {
      console.log(`无法申请 ${resource}；它已被 ${existing.owner} 锁定，有效期至 ${existing.expires_at ?? "手动释放"}。`);
      process.exit(2);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const startedAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  const lock = {
    owner: agent,
    resource,
    started_at: startedAt,
    expires_at: expiresAt,
    reason: args.reason && args.reason !== true ? String(args.reason) : "未说明"
  };
  await writeJson(filePath, lock);
  await appendLog({ event: "lock_claimed", agent, resource, expires_at: expiresAt });
  console.log(`已申请资源锁：${resource}，持有者=${agent}，有效期至=${expiresAt}`);
}

if (command === "release") {
  try {
    const existing = await readJson(filePath);
    if (existing.owner !== agent) {
      console.log(`无法释放 ${resource}；当前锁持有者是 ${existing.owner}。`);
      process.exit(2);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`没有找到资源锁：${resource}`);
      process.exit(0);
    }
    throw error;
  }

  await fs.unlink(filePath);
  await appendLog({ event: "lock_released", agent, resource });
  console.log(`已释放资源锁：${resource}`);
}
