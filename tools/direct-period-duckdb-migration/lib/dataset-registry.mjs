import { pathToFileURL } from "node:url";
import path from "node:path";

export const DEFAULT_QUANT_ROOT = "C:/Workspace/Quanttrading/Quanttrading";
const FAR_FUTURE_END_EXCLUSIVE = "2030-01-01";
const FAR_FUTURE_END = "2029-12-31";

export async function loadRouter(quantRoot = DEFAULT_QUANT_ROOT) {
  const routerPath = path.resolve(quantRoot, "server/db/query-entry-router.mjs");
  return import(pathToFileURL(routerPath).href);
}

export function buildDatasetRegistry(router) {
  return {
    daily_basic: {
      dataset: "daily_basic",
      srcTable: "daily_basic",
      period: { start: "2021-01-01", end: FAR_FUTURE_END, end_exclusive: FAR_FUTURE_END_EXCLUSIVE },
      keyColumns: ["ts_code", "trade_date"],
      canonicalColumns: router.DAILY_BASIC_CANONICAL_COLUMNS,
      numericColumns: ["turnover_rate", "volume_ratio", "pe", "pb", "ps", "total_mv", "circ_mv"],
      normalizeFn: "normalizeDailyBasicPointer",
      classifyFn: "classifyDailyBasicTradeDate",
      buildFn: "buildDailyBasicRouteQuery",
      contractPath: "metadata/dataset-contracts/daily_basic.json",
    },
    bar_daily: {
      dataset: "bar_daily",
      srcTable: "bar_daily",
      period: { start: "2005-01-01", end: FAR_FUTURE_END, end_exclusive: FAR_FUTURE_END_EXCLUSIVE },
      keyColumns: ["ts_code", "trade_date"],
      canonicalColumns: router.BAR_DAILY_CANONICAL_COLUMNS,
      numericColumns: ["open", "high", "low", "close", "pre_close", "pct_chg", "volume", "amount", "adj_factor"],
      normalizeFn: "normalizeBarDailyPointer",
      classifyFn: "classifyBarDailyTradeDate",
      buildFn: "buildBarDailyRouteQuery",
      contractPath: "metadata/dataset-contracts/bar_daily.json",
    },
    bar_minute: {
      dataset: "bar_minute",
      srcTable: "bar_minute",
      period: { start: "2022-01-01", end: FAR_FUTURE_END, end_exclusive: FAR_FUTURE_END_EXCLUSIVE },
      // Corrected key: metadata/dataset-contracts/bar_minute.json states [ts_code, trade_time], but the
      // live source has no trade_time column (it is named `ts`), and the table mixes freq='1m'/'30m' bars
      // that can share the same (ts_code, ts) -- (ts_code, ts) alone had 3,760 duplicate groups when checked.
      keyColumns: ["ts_code", "ts", "freq"],
      canonicalColumns: router.BAR_MINUTE_CANONICAL_COLUMNS,
      numericColumns: ["open", "high", "low", "close", "volume", "amount", "raw_count"],
      normalizeFn: "normalizeBarMinutePointer",
      classifyFn: "classifyBarMinuteTradeDate",
      buildFn: "buildBarMinuteRouteQuery",
      contractPath: "metadata/dataset-contracts/bar_minute.json",
    },
    moneyflow_daily: {
      dataset: "moneyflow_daily",
      srcTable: "moneyflow_daily",
      period: { start: "2010-01-01", end: FAR_FUTURE_END, end_exclusive: FAR_FUTURE_END_EXCLUSIVE },
      keyColumns: ["ts_code", "trade_date"],
      canonicalColumns: router.MONEYFLOW_DAILY_CANONICAL_COLUMNS,
      numericColumns: ["buy_lg_amount", "sell_lg_amount", "buy_elg_amount", "sell_elg_amount", "net_mf_amount"],
      normalizeFn: "normalizeMoneyflowDailyPointer",
      classifyFn: "classifyMoneyflowDailyTradeDate",
      buildFn: "buildMoneyflowDailyRouteQuery",
      contractPath: "metadata/dataset-contracts/moneyflow_daily.json",
    },
  };
}

export async function getDatasetConfig(name, quantRoot = DEFAULT_QUANT_ROOT) {
  const router = await loadRouter(quantRoot);
  const registry = buildDatasetRegistry(router);
  const config = registry[name];
  if (!config) {
    throw new Error(`unknown dataset: ${name}. Known datasets: ${Object.keys(registry).join(", ")}`);
  }
  return { config, router };
}

export function datasetNames() {
  return ["daily_basic", "bar_daily", "bar_minute", "moneyflow_daily"];
}
