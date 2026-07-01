#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs, readJson, requireArg, ROOT } from "./lib/core.mjs";

function usage() {
  console.log("用法：");
  console.log('  node tools/ai-coord/knowledge-search.mjs --spec <spec-name> --query "<关键词>"');
}

function tokenize(query) {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function countMatches(haystack, tokens) {
  const lower = haystack.toLowerCase();
  return tokens.reduce((count, token) => count + (lower.includes(token) ? 1 : 0), 0);
}

function snippetAround(content, token) {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(token.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - 60);
  const end = Math.min(content.length, idx + token.length + 60);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

const args = parseArgs(process.argv.slice(2));
if (!args.spec || !args.query) {
  usage();
  process.exit(1);
}
const spec = requireArg(args, "spec");
const query = requireArg(args, "query");
const tokens = tokenize(query);

if (!tokens.length) {
  usage();
  throw new Error("--query 不能为空");
}

const manifestPath = path.join(ROOT, ".kiro", "specs", spec, "knowledge", "manifest.json");

let manifest;
try {
  manifest = await readJson(manifestPath);
} catch (error) {
  if (error.code === "ENOENT") {
    console.log(`没有找到知识库清单：${manifestPath}`);
    process.exit(0);
  }
  throw error;
}

const results = [];

for (const doc of manifest.docs ?? []) {
  const titleAndTags = `${doc.title ?? ""} ${(doc.tags ?? []).join(" ")}`;
  let score = countMatches(titleAndTags, tokens);
  let snippet = "";

  if (doc.source === "inline") {
    // inline 文档预期放在这个 spec 的 knowledge/ 目录下，做全文索引。
    const docPath = path.isAbsolute(doc.path)
      ? doc.path
      : path.join(ROOT, ".kiro", "specs", spec, doc.path);
    try {
      const content = await fs.readFile(docPath, "utf8");
      score += countMatches(content, tokens);
      const firstHit = tokens.find((token) => content.toLowerCase().includes(token));
      if (firstHit) snippet = snippetAround(content, firstHit);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      snippet = "（inline 文档文件缺失，仅按标题/标签匹配）";
    }
  } else if (doc.source === "external") {
    // external 文档可能指向姊妹仓库、当前系统未必能读到；只按 title/tags 匹配，不尝试读文件内容。
    snippet = "（external 文档，仅按标题/标签匹配，不读取文件内容）";
  }

  if (score > 0) {
    results.push({ doc, score, snippet });
  }
}

results.sort((a, b) => b.score - a.score);

if (!results.length) {
  console.log(`没有命中：spec=${spec} query="${query}"`);
  process.exit(0);
}

console.log(`知识库检索结果：spec=${spec} query="${query}"`);
console.log("=================================");
for (const { doc, score, snippet } of results) {
  console.log(`- ${doc.id}（${doc.source}）score=${score}：${doc.title}`);
  if (doc.tags?.length) console.log(`  tags: ${doc.tags.join(", ")}`);
  console.log(`  path: ${doc.path}`);
  if (snippet) console.log(`  片段: ${snippet}`);
}
