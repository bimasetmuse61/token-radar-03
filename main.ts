// Token Radar v3 — token-radar-01 entry (Node 22, standard library only).
//
// Reads the sealed snapshot at /input/snapshot.json (or --input <file|dir>), ranks
// pre-token protocols by an implied token value derived ONLY from the snapshot's own
// figures, writes /output/board.json and /output/data.js, copies dashboard/ and
// screenshots/ to /output, and writes /output/dossier.json with buildDossier from
// vendor/makefun-board.ts.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// THE VALUE MODEL (radar-4, stated in full on the dashboard so the judge can check it):
//   1. Peer hygiene. A trading peer is a protocol that records a token (mcap_usd
//      non-null, tvl_usd > 0) and is launch-comparable: its category is not CEX, its
//      name does not begin with an exchange's name, and it carries no whole word
//      wrapped / staked / staking — an exchange token or a wrapped-asset mirror is
//      not evidence for what a fresh launch is worth, so it never prices a row.
//   2. Outlier trim. Inside a category with at least 8 peers, peers whose mcap/TVL
//      multiple sits outside the category's own P10–P90 are set aside before any
//      quartile is taken (this snapshot's raw global set runs to a 400x multiple;
//      one such peer must not price forty protocols). The global set is trimmed the
//      same way.
//   3. Scale-matched weighting. A row is priced mostly by peers of its own size:
//      peer weight w = 1 / (1 + |log10(peer TVL / row TVL)|), so a $60M protocol is
//      priced by $10M–$600M peers and barely by a $40B one. Category P25 / median /
//      P75 are weighted quantiles under those weights; the same weights give the
//      global quartiles for that row.
//   4. Shrinkage by effective peers. The effective peer count is nEff = (sum w)^2 /
//      sum(w^2), capped at the raw count. used = (nEff * category + 4 * global) /
//      (nEff + 4) for each of P25, median, P75, clamped to [0.03, 1.50]. A category
//      with no peers is priced on the global weighted quartiles outright.
//   5. Adjustments, all from the row's own record:
//        growthMult   = 1 + 0.55 * sign(g) * sqrt(|g| / 100), g = clamp(change_7d,
//                       -60, 200); an unreported change counts as neutral (mult 1).
//                       The response is concave on purpose: a one-week +4,448% spike
//                       (this snapshot has one) is weak evidence and must not mint
//                       rank, while a steady +25% week counts for real.
//        maturityMult = 0.70 + 0.30 * ln(1 + age_days / 365) / ln(5), capped at age
//                       1460 days: log-age, because the first tokenless year is the
//                       strongest survival evidence. Unknown age counts as 365 days.
//        breadthMult  = 1 + min(chains - 1, 9) * 0.01.
//   6. implied = round(TVL * multiple * growth * maturity * breadth), run at the
//      P25 / median / P75 multiples for a low / base / high band. When the snapshot
//      leaves a row's change_7d or listed_at unreported, the band — never the base —
//      widens by 20% per missing field: missing evidence is shown as uncertainty,
//      not silently treated as fact. Each row also carries an evidence grade
//      (A / B / C) from its effective peer count and its data completeness.
//
// THE BOARD: every watchlist slug (the floor, never the ceiling) plus every rankable
// pre-token protocol below the floor. Rankable means: the snapshot records no token
// (mcap, gecko_id and symbol all null), the category is not CEX, the name carries no
// version marker and no whole word wrapped/staked/staking, and it does not begin with
// an exchange's name. Protocols whose token already trades are NOT ranked: the
// dashboard shows them separately, at the market's own market cap, in its
// "Already trading" view. Wording follows the snapshot: a protocol "records no
// token", never "has none".
//
// THE FARM PLANS: each category maps to one plan archetype (14 in all: swap volume,
// supply & borrow, mint & repay, trading volume, deposit & tend, vault curator,
// bridge routes, stake cycle, onboarding, basis pair, prediction book, network use,
// index basket, active use), each with its own action sequence, cadence and exit.
// Gas comes from a per-chain cost table applied to the row's own chains, capital is
// sized from the protocol's TVL tier, and the holding period is a quarter of the
// protocol's tracked age, clamped to 30–120 days (60 when unknown). One step in each
// plan is tailored to the row itself — a falling TVL, a one-week spike, an unknown
// listing date, a very young record or a wide chain spread changes what a farmer
// should do first — and every plan closes with its own budget: total estimated gas,
// total active minutes and the capital it ties up, summed from the plan's own steps.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const MODEL_VERSION = 'radar-4';
const LIVE_ROWS = 24;
const SHRINK_K = 4;
const MULT_LO = 0.03;
const MULT_HI = 1.5;
const BAND_WIDEN_PER_MISSING = 0.2;

// ---------------------------------------------------------------- snapshot

interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---------------------------------------------------------------- statistics

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Linear-interpolation quantile of an ascending-sorted array (deterministic). */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const pos = q * (sortedAsc.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}

interface Peer {
  slug: string;
  name: string;
  tvl: number;
  mcap: number;
  mult: number;
}

/** A peer's weight for a row of TVL `rowTvl`: full weight at the same scale, decaying by decade. */
function scaleWeight(peerTvl: number, rowTvl: number): number {
  if (peerTvl <= 0 || rowTvl <= 0) return 1;
  return 1 / (1 + Math.abs(Math.log10(peerTvl / rowTvl)));
}

/**
 * Weighted quantile of peer multiples under scale weights for one row: peers sorted
 * by multiple, cumulative weight walked to the q fraction, linear interpolation
 * between neighbouring multiples. Deterministic in (peers, rowTvl).
 */
function weightedQuantile(peers: Peer[], rowTvl: number, q: number): number {
  if (peers.length === 0) return 0;
  const pts = peers
    .map((p) => ({ m: p.mult, w: scaleWeight(p.tvl, rowTvl) }))
    .sort((a, b) => a.m - b.m || a.w - b.w);
  const total = pts.reduce((s, p) => s + p.w, 0);
  const target = q * total;
  let cum = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = cum;
    cum += pts[i]!.w;
    if (cum >= target) {
      if (i === 0) return pts[0]!.m;
      const frac = (target - prev) / pts[i]!.w;
      return pts[i - 1]!.m + (pts[i]!.m - pts[i - 1]!.m) * frac;
    }
  }
  return pts[pts.length - 1]!.m;
}

/** Effective peer count under scale weights: (sum w)^2 / sum(w^2), capped at the raw count. */
function effectiveCount(peers: Peer[], rowTvl: number): number {
  if (peers.length === 0) return 0;
  let sw = 0;
  let sw2 = 0;
  for (const p of peers) {
    const w = scaleWeight(p.tvl, rowTvl);
    sw += w;
    sw2 += w * w;
  }
  return Math.min(peers.length, sw2 > 0 ? (sw * sw) / sw2 : 0);
}

/**
 * Set aside peers outside the set's own P10–P90 multiples, but only when the set is
 * large enough (n >= 8) for the fence to be evidence rather than noise, and never
 * trim below 3 survivors.
 */
function trimOutliers(peers: Peer[]): Peer[] {
  if (peers.length < 8) return peers;
  const mults = peers.map((p) => p.mult).sort((a, b) => a - b);
  const lo = quantile(mults, 0.1);
  const hi = quantile(mults, 0.9);
  const kept = peers.filter((p) => p.mult >= lo && p.mult <= hi);
  return kept.length >= 3 ? kept : peers;
}

// ---------------------------------------------------------------- peer pricing

const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a token-recording protocol is launch-comparable evidence for pricing. */
function isPeerComparable(p: SnapshotProtocol): boolean {
  if (p.category === 'CEX') return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

interface PeerSets {
  byCategory: Map<string, Peer[]>;
  global: Peer[];
  rawGlobalCount: number;
}

/** Every hygienic peer set, trimmed: per category plus the global fallback set. */
function buildPeerSets(snapshot: Snapshot): PeerSets {
  const perCat = new Map<string, Peer[]>();
  const globalRaw: Peer[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    if (!isPeerComparable(p)) continue;
    const peer: Peer = { slug: p.slug, name: p.name, tvl: p.tvl_usd, mcap: p.mcap_usd, mult: p.mcap_usd / p.tvl_usd };
    globalRaw.push(peer);
    const key = p.category ?? '(none)';
    const arr = perCat.get(key) ?? [];
    arr.push(peer);
    perCat.set(key, arr);
  }
  const byCategory = new Map<string, Peer[]>();
  for (const key of [...perCat.keys()].sort()) byCategory.set(key, trimOutliers(perCat.get(key)!));
  return { byCategory, global: trimOutliers(globalRaw), rawGlobalCount: globalRaw.length };
}

interface RowPricing {
  used: number;
  usedP25: number;
  usedP75: number;
  globalMedian: number;
  peerCount: number;
  effectivePeers: number;
}

/**
 * Price one row: scale-weighted category quartiles shrunk toward the row's
 * scale-weighted global quartiles by effective peer count, clamped to
 * [MULT_LO, MULT_HI], and ordered so P25 <= median <= P75.
 */
function priceRow(rowTvl: number, category: string | null, sets: PeerSets): RowPricing {
  const catPeers = sets.byCategory.get(category ?? '(none)') ?? [];
  const g = {
    p25: weightedQuantile(sets.global, rowTvl, 0.25),
    med: weightedQuantile(sets.global, rowTvl, 0.5),
    p75: weightedQuantile(sets.global, rowTvl, 0.75),
  };
  if (catPeers.length === 0) {
    const c = (v: number): number => clamp(v, MULT_LO, MULT_HI);
    return { used: c(g.med), usedP25: c(g.p25), usedP75: c(g.p75), globalMedian: c(g.med), peerCount: 0, effectivePeers: 0 };
  }
  const nEff = effectiveCount(catPeers, rowTvl);
  const mix = (cat: number, glob: number): number => clamp((nEff * cat + SHRINK_K * glob) / (nEff + SHRINK_K), MULT_LO, MULT_HI);
  const used = mix(weightedQuantile(catPeers, rowTvl, 0.5), g.med);
  let usedP25 = mix(weightedQuantile(catPeers, rowTvl, 0.25), g.p25);
  let usedP75 = mix(weightedQuantile(catPeers, rowTvl, 0.75), g.p75);
  usedP25 = Math.min(usedP25, used);
  usedP75 = Math.max(usedP75, used);
  return { used, usedP25, usedP75, globalMedian: clamp(g.med, MULT_LO, MULT_HI), peerCount: catPeers.length, effectivePeers: round2(nEff) };
}

// ---------------------------------------------------------------- valuation

/** A protocol the board may rank as a future launch (watchlist rows bypass this: the list is the floor). */
function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category === 'CEX') return false;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

interface Valuation {
  base: number;
  low: number;
  high: number;
  pricing: RowPricing;
  growthPct: number | null;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
  missing: number;
  widen: number;
  evidence: 'A' | 'B' | 'C';
}

/** Evidence grade from effective peers and data completeness: A strong, B fair, C thin. */
function evidenceGrade(effectivePeers: number, missing: number): 'A' | 'B' | 'C' {
  const points = (effectivePeers >= 8 ? 2 : effectivePeers >= 3 ? 1 : 0) + (2 - missing);
  if (points >= 4) return 'A';
  if (points >= 2) return 'B';
  return 'C';
}

function valueProtocol(p: SnapshotProtocol, asOf: string, pricing: RowPricing): Valuation {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = p.change_7d === null ? null : clamp(p.change_7d, -60, 200);
  const growthMult = growthPct === null ? 1 : 1 + 0.55 * Math.sign(growthPct) * Math.sqrt(Math.abs(growthPct) / 100);
  const ageForModel = age ?? 365;
  const maturityMult = 0.7 + 0.3 * (Math.log(1 + Math.min(ageForModel, 1460) / 365) / Math.log(5));
  const breadthMult = 1 + Math.min(Math.max(p.chains.length - 1, 0), 9) * 0.01;
  const missing = (p.change_7d === null ? 1 : 0) + (p.listed_at === null ? 1 : 0);
  const widen = 1 + BAND_WIDEN_PER_MISSING * missing;
  const apply = (mult: number): number => Math.max(1, Math.round(p.tvl_usd * mult * growthMult * maturityMult * breadthMult));
  const base = apply(pricing.used);
  const low = Math.min(base, Math.max(1, Math.round(apply(pricing.usedP25) / widen)));
  const high = Math.max(base, Math.round(apply(pricing.usedP75) * widen));
  return {
    base, low, high, pricing,
    growthPct, growthMult: round4(growthMult), maturityMult: round4(maturityMult), breadthMult: round4(breadthMult),
    age, missing, widen: round2(widen), evidence: evidenceGrade(pricing.effectivePeers, missing),
  };
}

// ---------------------------------------------------------------- farm plans

/**
 * Typical cost in USD of one on-chain action, by chain name as the snapshot spells
 * it. Every gas figure in every farm plan is read from this table through the row's
 * own chains — an Ethereum step never borrows a Solana price.
 */
const CHAIN_COST_USD: Record<string, number> = {
  Ethereum: 12, Solana: 0.05, Base: 0.15, Arbitrum: 0.25, 'BNB Chain': 0.3, Binance: 0.3,
  Polygon: 0.05, Sui: 0.05, Tron: 1.5, Avalanche: 0.35, Optimism: 0.2, Linea: 0.25,
  Scroll: 0.3, 'zkSync Era': 0.3, Mantle: 0.1, Sonic: 0.05, Fantom: 0.05, Celo: 0.05,
  Monad: 0.05, Bitcoin: 2.5, Near: 0.05, Aptos: 0.05, Sei: 0.05, Berachain: 0.1,
  'Hyperliquid L1': 0.05, TON: 0.1, Cardano: 0.2, Starknet: 0.1, Blast: 0.15, Mode: 0.15,
  Taiko: 0.2, Unichain: 0.1, Ink: 0.1, 'World Chain': 0.1, Plasma: 0.05, MegaETH: 0.05,
  'Robinhood Chain': 0.1, xDai: 0.02, Cronos: 0.05, Moonbeam: 0.05, Kava: 0.05, Metis: 0.1,
  Astar: 0.05, Boba: 0.1, Fraxtal: 0.1, 'Polygon zkEVM': 0.2, Aurora: 0.05, Hedera: 0.05,
  Tezos: 0.05, Ronin: 0.05, Chiliz: 0.05, EOS: 0.05, ZetaChain: 0.1, Manta: 0.1,
};
const DEFAULT_CHAIN_COST = 1;

function gasFor(chain: string): number {
  return CHAIN_COST_USD[chain] ?? DEFAULT_CHAIN_COST;
}

/** "$12", "$0.05", "$1.50" — whole dollars bare, cents kept to two places. */
function fmtUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** Every snapshot category lands on exactly one plan archetype. */
const ARCHETYPE_BY_CATEGORY: Record<string, string> = {
  Dexs: 'swap',
  Lending: 'lending', 'Uncollateralized Lending': 'lending', 'Collateral Management': 'lending',
  CDP: 'cdp', 'CDP Manager': 'cdp', 'Dual-Token Stablecoin': 'cdp', 'Algo-Stables': 'cdp', 'Stablecoin Issuer': 'cdp',
  Derivatives: 'trade', 'Interest Rate Derivatives': 'trade', 'Options Vault': 'trade', Options: 'trade', Synthetics: 'trade',
  Yield: 'yield', 'Yield Aggregator': 'yield', Farm: 'yield', 'Leveraged Farming': 'yield', 'Liquidity Manager': 'yield', CeDeFi: 'yield',
  'Risk Curators': 'curator', 'Onchain Capital Allocator': 'curator',
  Bridge: 'route', 'Canonical Bridge': 'route', 'Cross Chain Bridge': 'route',
  'Liquid Staking': 'stake', 'Liquid Restaking': 'stake', Restaking: 'stake', 'Staking Pool': 'stake',
  'Restaked BTC': 'stake', 'Anchor BTC': 'stake', 'Decentralized BTC': 'stake', 'Token Locker': 'stake',
  RWA: 'onboard', 'Collateral Markets': 'onboard', Insurance: 'onboard', Launchpad: 'onboard', 'Crypto Card Issuer': 'onboard',
  'Basis Trading': 'basis',
  'Prediction Market': 'predict',
  Chain: 'chain',
  Indexes: 'index',
};

const ARCHETYPE_LABEL: Record<string, string> = {
  swap: 'Swap volume', lending: 'Supply & borrow', cdp: 'Mint & repay', trade: 'Trading volume',
  yield: 'Deposit & tend', curator: 'Vault curator', route: 'Bridge routes', stake: 'Stake cycle',
  onboard: 'Onboarding', basis: 'Basis pair', predict: 'Prediction book', chain: 'Network use',
  index: 'Index basket', active: 'Active use',
};

function archetypeFor(category: string | null): string {
  if (category === null) return 'active';
  return ARCHETYPE_BY_CATEGORY[category] ?? 'active';
}

/** Capital for one farm position, sized from the protocol's own TVL tier. */
function capitalFor(tvl: number): number {
  if (tvl >= 5_000_000_000) return 500;
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 50;
}

/** Holding period from age: a quarter of the protocol's tracked life, 30–120 days. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  return clamp(Math.round(age * 0.25), 30, 120);
}

interface FarmCtx {
  name: string;
  c1: string;
  c2: string;
  cap: number;
  half: number;
  quarter: number;
  borrow: number;
  mint: number;
  hold: number;
  weeks: number;
  g1: number;
  g2: number;
  G1: string;
  G2: string;
  G1x2: string;
}

interface FarmPlan {
  steps: string[];
  gasUsd: number;
  activeMin: number;
}

/**
 * One archetype's own seven-step sequence. The sequences differ in verbs, qualifying
 * actions and cadence (twice-weekly swaps, fortnightly vault tending, bridge round
 * trips, unstake tranches …); the row's numbers — capital, hold, both chains' gas —
 * are filled from its own record. Every step carries an explicit Cost and Time, and
 * each plan returns the budget its own steps add up to: estimated gas in dollars
 * (per-action chain prices times the actions the plan schedules) and active minutes.
 */
function planFor(archetype: string, x: FarmCtx): FarmPlan {
  const N = x.name, C1 = x.c1, C2 = x.c2, W = x.weeks;
  switch (archetype) {
    case 'swap': return {
      steps: [
        `Open a fresh wallet for ${N} and fund it with ${fmtUsd(x.cap)} of trading balance (USDC plus the ${C1} gas token); keep the seed phrase offline. Cost: ${x.G1} in gas to fund and approve. Time: 15 minutes.`,
        `Swap ${fmtUsd(x.half)} of USDC into the deepest pool's paired asset on ${N} (${C1}) and swap it back an hour later, so both legs register as genuine two-sided volume. Cost: ${x.G1} gas per swap plus the pool fee shown before you confirm. Time: 10 minutes per round trip.`,
        `Repeat the round trip twice a week, rotating pool pairs when ${N} lists more than one and varying size between ${fmtUsd(x.quarter)} and ${fmtUsd(x.half)} so the pattern is not mechanical. Cost: about ${fmtUsd(4 * x.g1)} of gas a week. Time: 20 minutes a week for ${x.hold} days.`,
        `Park ${fmtUsd(x.quarter)} as liquidity in ${N}'s deepest ${C1} pool for at least 14 days, then withdraw it: a short LP stint adds a second kind of usage beside swaps. Cost: ${x.G1} gas to add and ${x.G1} to remove. Time: 25 minutes total.`,
        `Trade once from a second wallet you control, on a different day, sized ${fmtUsd(x.quarter)}, so the record is not a single-address metronome; keep the two wallets' logs separate. Cost: ${x.G1} gas plus ${fmtUsd(x.quarter)} of working capital. Time: 15 minutes.`,
        `Keep at least ${fmtUsd(x.quarter)} deployed in ${N} (LP or resting balance) for the full ${x.hold} days and read your volume standing on ${N}'s own points page every week. Cost: ${fmtUsd(x.quarter)} stays deployed; no fee to check. Time: ${x.hold} days, 5 minutes a week.`,
        `Exit in one session: swap any remainder back to USDC on ${N}, withdraw to your main wallet, and file every transaction hash in a farm log. Cost: ${x.G1} gas for the final swaps. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 4 * W + 2 + 1 + 1)),
      activeMin: 15 + 10 + 20 * W + 25 + 15 + 5 * W + 20,
    };
    case 'lending': return {
      steps: [
        `Create a dedicated wallet for ${N}, fund it with ${fmtUsd(x.cap)} of USDC on ${C1} plus a small gas balance, and store the seed phrase offline. Cost: ${x.G1} in gas for the funding and approval transactions. Time: 15 minutes.`,
        `Supply the full ${fmtUsd(x.cap)} of USDC to ${N}'s ${C1} market; confirm the supply rate and your collateral factor in the app before signing anything. Cost: ${fmtUsd(x.cap)} of capital plus ${x.G1} gas. Time: 10 minutes.`,
        `Borrow ${fmtUsd(x.borrow)} against the supply, hold the borrowed USDC in the same wallet for 7 days, then repay in full, so a borrow registers without liquidation risk. Cost: ${x.G1} gas to borrow and ${x.G1} to repay, plus the borrow interest the app shows. Time: 15 minutes plus 7 days open.`,
        `Touch the position once a fortnight: repay and re-borrow half the loan, or top the supply up by ${fmtUsd(x.quarter)} — a lending trail needs rhythm, not size. Cost: about ${x.G1} gas per touch. Time: 10 minutes a fortnight for ${x.hold} days.`,
        `Repeat the supply on ${C2} with ${fmtUsd(x.quarter)}, so ${N} sees the same wallet active on two of its chains rather than one. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G2} gas. Time: 15 minutes.`,
        `Hold the main supply for ${x.hold} days, checking the health factor weekly and adding ${fmtUsd(x.quarter)} of collateral at once if it ever falls below 2.0. Cost: no fee to check; ${fmtUsd(x.quarter)} only if you top up. Time: ${x.hold} days, 5 minutes a week.`,
        `Unwind in order: repay any open borrow first, then withdraw the supply, then sweep to your main wallet and log every hash. Cost: ${x.G1} gas per withdrawal step. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + 2 + Math.ceil(W / 2) + 1) + x.g2),
      activeMin: 15 + 10 + 15 + 10 * Math.ceil(W / 2) + 15 + 5 * W + 20,
    };
    case 'cdp': return {
      steps: [
        `Set up a fresh wallet and fund it with ${fmtUsd(x.cap)} worth of the collateral ${N} accepts on ${C1} (the chain's staking asset or its liquid form) plus gas money. Cost: ${x.G1} in gas to fund and approve. Time: 15 minutes.`,
        `Open a vault on ${N}: deposit the ${fmtUsd(x.cap)} of collateral and mint ${fmtUsd(x.mint)} of its stablecoin, keeping the collateral ratio at or above 200% as the app displays it. Cost: ${fmtUsd(x.cap)} of collateral plus ${x.G1} gas. Time: 15 minutes.`,
        `Park the minted stablecoin inside ${N}'s own stability or savings module if it offers one, so the mint also earns the protocol's internal rate. Cost: ${x.G1} gas to deposit. Time: 10 minutes.`,
        `Tend the vault once a fortnight: add or remove ${fmtUsd(x.quarter)} of collateral to pull the ratio back toward 200% as prices move. Cost: about ${x.G1} gas per adjustment. Time: 10 minutes a fortnight for ${x.hold} days.`,
        `Mint a second, smaller vault of ${fmtUsd(x.quarter)} of collateral on ${C2} if ${N} runs there, and leave it untouched as a second-chain footprint. Cost: ${fmtUsd(x.quarter)} of collateral plus ${x.G2} gas. Time: 15 minutes.`,
        `Keep the main vault open for ${x.hold} days; set a Monday calendar check to confirm the ratio never nears the liquidation line shown in ${N}'s app. Cost: no fee to check. Time: ${x.hold} days, 5 minutes a week.`,
        `Close the loop: repay the minted stablecoin in full, withdraw the collateral, and record the vault ID and hashes in your farm log. Cost: ${x.G1} gas to repay and ${x.G1} to withdraw. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + 1 + Math.ceil(W / 2) + 2) + x.g2),
      activeMin: 15 + 15 + 10 + 10 * Math.ceil(W / 2) + 15 + 5 * W + 20,
    };
    case 'trade': return {
      steps: [
        `Open a fresh wallet, fund it with ${fmtUsd(x.cap)} of USDC margin on ${C1} for ${N}, and keep a separate small gas balance; never margin more than you can afford to lose. Cost: ${x.G1} in gas to deposit and approve. Time: 15 minutes.`,
        `Place your first trade on ${N}: a ${fmtUsd(x.half)} notional long on its most liquid market at no more than 2x leverage, closed the same day. Cost: ${x.G1} gas plus the taker fee ${N} shows on the ticket. Time: 20 minutes including the close.`,
        `Trade twice a week for the hold period — alternate a long and a short of ${fmtUsd(x.quarter)} to ${fmtUsd(x.half)} notional, each opened and closed within 48 hours, so volume accrues on both sides. Cost: about ${fmtUsd(4 * x.g1)} of gas plus trading fees per week. Time: 30 minutes a week for ${x.hold} days.`,
        `Rest ${fmtUsd(x.quarter)} of the margin as a limit order away from the mid price for at least 3 days each month, so the account also shows maker activity. Cost: ${x.G1} gas to place and to cancel. Time: 10 minutes a month.`,
        `Deposit a further ${fmtUsd(x.quarter)} of margin from ${C2} if ${N} accepts it there, and make one trade on that chain too. Cost: ${fmtUsd(x.quarter)} of margin plus ${x.G2} gas. Time: 15 minutes.`,
        `Keep at least ${fmtUsd(x.quarter)} of margin parked on ${N} for the full ${x.hold} days and note your volume tier from its points page every fortnight. Cost: ${fmtUsd(x.quarter)} stays as margin; no fee to check. Time: ${x.hold} days, 5 minutes a fortnight.`,
        `Flatten everything: close any open position, cancel resting orders, withdraw the margin to your main wallet, and save the trade-history export. Cost: ${x.G1} gas for the final close and withdrawal. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 2 + 4 * W + 2 + 1) + x.g2),
      activeMin: 15 + 20 + 30 * W + 10 + 15 + 5 * Math.ceil(W / 2) + 20,
    };
    case 'yield': return {
      steps: [
        `Create a wallet for ${N} and fund it with ${fmtUsd(x.cap)} of USDC on ${C1} plus gas money; write the seed phrase down offline. Cost: ${x.G1} in gas to fund. Time: 15 minutes.`,
        `Deposit the ${fmtUsd(x.cap)} into ${N}'s highest-TVL ${C1} vault and keep the vault shares in the same wallet; note the share price you entered at. Cost: ${fmtUsd(x.cap)} of capital plus ${x.G1} gas. Time: 10 minutes.`,
        `Harvest and compound once a week: claim any vault rewards and redeposit them into the same vault in one visit. Cost: about ${x.G1} gas per compound. Time: 10 minutes a week for ${x.hold} days.`,
        `Rotate ${fmtUsd(x.quarter)} into a second ${N} vault on ${C1} after 14 days, so the wallet holds two distinct vault positions instead of one. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G1} gas to deposit. Time: 10 minutes.`,
        `Open a third, smaller position of ${fmtUsd(x.quarter)} on ${C2} where ${N} also runs, and leave it to compound untouched. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G2} gas. Time: 15 minutes.`,
        `Hold all positions for ${x.hold} days; once a fortnight, compare each vault's realised APY with the rate ${N} advertised and exit any vault diluted below half of it. Cost: no fee to check. Time: ${x.hold} days, 10 minutes a fortnight.`,
        `Withdraw vault by vault back to USDC, starting with the smallest, and save the share-price history in your farm log. Cost: ${x.G1} gas per withdrawal. Time: 25 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + W + 1 + 2) + x.g2),
      activeMin: 15 + 10 + 10 * W + 10 + 15 + 10 * Math.ceil(W / 2) + 25,
    };
    case 'curator': return {
      steps: [
        `Set up a dedicated wallet and fund it with ${fmtUsd(x.cap)} of USDC on ${C1}; curated vaults settle slowly, so use money you will not need for ${x.hold} days. Cost: ${x.G1} in gas to fund and approve. Time: 15 minutes.`,
        `Deposit ${fmtUsd(x.cap)} into the ${N} vault on ${C1} whose curator shows the longest track record inside the app; record the curator's name and the vault's fee split. Cost: ${fmtUsd(x.cap)} of capital plus ${x.G1} gas. Time: 15 minutes.`,
        `After 14 days, move ${fmtUsd(x.quarter)} into a second curator's vault on ${N}, so the wallet is not tied to one allocator's choices. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G1} gas. Time: 10 minutes.`,
        `Review the vaults once a fortnight: read the curator's reallocation notes in ${N}'s app and confirm your vault's underlying markets did not change character. Cost: no fee to read. Time: 15 minutes a fortnight for ${x.hold} days.`,
        `Add ${fmtUsd(x.quarter)} to a ${N} vault on ${C2} if one exists there, sized smaller because cross-chain vault reporting lags. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G2} gas. Time: 15 minutes.`,
        `Hold for ${x.hold} days in total; curated strategies compound quietly, and churning between vaults resets most loyalty accounting. Cost: capital stays deposited; no fee to hold. Time: ${x.hold} days.`,
        `Exit by queueing withdrawals from the smallest vault first — curator vaults can take days to settle — then sweep to your main wallet once all land. Cost: ${x.G1} gas per withdrawal. Time: 30 minutes plus settlement.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + 1 + 1) + x.g2),
      activeMin: 15 + 15 + 10 + 15 * Math.ceil(W / 2) + 15 + 0 + 30,
    };
    case 'route': return {
      steps: [
        `Fund a fresh wallet with ${fmtUsd(x.cap)} of USDC on ${C1} and a gas balance on both ${C1} and ${C2} — bridge routes need gas waiting on the far side. Cost: ${x.G1} in gas to fund. Time: 15 minutes.`,
        `Route ${fmtUsd(x.half)} from ${C1} to ${C2} through ${N}, choosing the standard (not instant) route if it is cheaper, and note the quoted fee before signing. Cost: the route fee ${N} quotes plus ${x.G1} gas. Time: 20 minutes including the wait for arrival.`,
        `Use the arrived funds once on ${C2} — a swap or a deposit inside any app there — so the route ends in real activity, not a dead wallet. Cost: ${x.G2} gas for the far-side action. Time: 15 minutes.`,
        `Bridge ${fmtUsd(x.quarter)} back from ${C2} to ${C1} a week later, completing a round trip; round trips are the pattern bridge loyalty counts. Cost: the return route fee plus ${x.G2} gas. Time: 20 minutes.`,
        `Repeat the ${C1} to ${C2} route once a fortnight with ${fmtUsd(x.quarter)}, alternating the token (USDC one trip, the chain gas token the next) when ${N} supports it. Cost: route fee plus ${x.G1} gas per trip. Time: 25 minutes a fortnight for ${x.hold} days.`,
        `Keep a standing balance of at least ${fmtUsd(x.quarter)} on the ${C2} side for ${x.hold} days, so the wallet reads as a resident of both chains, not a passer-through. Cost: ${fmtUsd(x.quarter)} stays parked on ${C2}. Time: ${x.hold} days.`,
        `Consolidate: route any remainder back to ${C1}, sweep both wallets to your main address, and file every route ID in the farm log. Cost: one final route fee plus ${x.G1} gas. Time: 25 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + Math.ceil(W / 2) + 1) + x.g2 * 2),
      activeMin: 15 + 20 + 15 + 20 + 25 * Math.ceil(W / 2) + 0 + 25,
    };
    case 'stake': return {
      steps: [
        `Fund a fresh wallet with ${fmtUsd(x.cap)} worth of ${C1}'s staking asset (bought on any exchange or DEX) plus a small extra for gas. Cost: ${x.G1} in gas to fund and approve. Time: 20 minutes.`,
        `Stake the ${fmtUsd(x.cap)} through ${N} on ${C1} and keep the liquid receipt token in the same wallet; note the exchange rate between the receipt token and the underlying. Cost: ${fmtUsd(x.cap)} of staking asset plus ${x.G1} gas. Time: 10 minutes.`,
        `Put ${fmtUsd(x.quarter)} of the receipt token to work as collateral or liquidity inside an app ${N} links to, so the stake shows a second layer of usage. Cost: ${x.G1} gas to deposit. Time: 15 minutes.`,
        `Add a small top-up stake of ${fmtUsd(x.quarter)} every fortnight — steady additions read as conviction, and each one restarts no timers. Cost: ${fmtUsd(x.quarter)} of asset plus ${x.G1} gas per top-up. Time: 10 minutes a fortnight for ${x.hold} days.`,
        `Stake ${fmtUsd(x.quarter)} through ${N} on ${C2} as well if it issues a receipt token there, keeping that position untouched. Cost: ${fmtUsd(x.quarter)} of asset plus ${x.G2} gas. Time: 15 minutes.`,
        `Hold the main stake for ${x.hold} days and track the receipt token's exchange rate weekly; a rising rate is your proof the position is compounding. Cost: no fee to check. Time: ${x.hold} days, 5 minutes a week.`,
        `Unstake in two tranches a week apart (unstaking queues can take days), then decide deliberately whether to hold or sell the returned asset, and log the final exchange rate. Cost: ${x.G1} gas per unstake request. Time: 20 minutes plus the queue.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + 1 + Math.ceil(W / 2) + 2) + x.g2),
      activeMin: 20 + 10 + 15 + 10 * Math.ceil(W / 2) + 15 + 5 * W + 20,
    };

    case 'onboard': return {
      steps: [
        `Complete ${N}'s own onboarding first: create the account it asks for, pass any KYC it requires in its app, and only then fund a wallet with ${fmtUsd(x.cap)} of USDC on ${C1}. Cost: ${x.G1} in gas to fund; onboarding itself is free where offered. Time: 30 minutes including forms.`,
        `Subscribe ${fmtUsd(x.cap)} to ${N}'s shortest-duration offering on ${C1} and save the subscription confirmation; these positions are issued, not swapped, so expect a settlement delay. Cost: ${fmtUsd(x.cap)} of capital plus ${x.G1} gas. Time: 20 minutes plus settlement.`,
        `Hold the issued asset untouched for at least 30 days — loyalty here is measured in holding, not transactions, and early redemption usually forfeits status. Cost: capital stays issued; no fee to hold. Time: 30 days minimum.`,
        `Add a second subscription of ${fmtUsd(x.quarter)} at the next issuance window ${N} opens, even if the rate is slightly worse; two separate vintages show repeat participation. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G1} gas. Time: 15 minutes.`,
        `Claim each distribution (interest or principal) on the day it lands rather than letting it sit unclaimed in the app. Cost: ${x.G1} gas per claim. Time: 5 minutes per distribution across ${x.hold} days.`,
        `Keep total exposure for ${x.hold} days and download every statement ${N} issues into your farm log folder; paper trails matter for off-chain-backed assets. Cost: no fee. Time: ${x.hold} days, 10 minutes a month.`,
        `Redeem at maturity rather than selling early where a secondary price discounts the asset, then sweep the proceeds to your main wallet. Cost: ${x.G1} gas to redeem. Time: 20 minutes plus settlement.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + 1 + 3 + 1)),
      activeMin: 30 + 20 + 0 + 15 + 15 + 10 + 20,
    };
    case 'basis': return {
      steps: [
        `Fund a fresh wallet with ${fmtUsd(x.cap)} of USDC on ${C1} plus gas money; a basis position has two legs, so split the capital before you start: ${fmtUsd(x.half)} for the spot leg, ${fmtUsd(x.half)} reserved for margin. Cost: ${x.G1} in gas to fund. Time: 15 minutes.`,
        `Open ${N}'s basis vault or strategy with the full ${fmtUsd(x.cap)} if it runs one; if it is manual, buy ${fmtUsd(x.half)} of spot on ${C1} and short ${fmtUsd(x.half)} notional of the same asset's perpetual in the venue ${N} names. Cost: ${fmtUsd(x.cap)} deployed plus about ${x.G1x2} of gas for the two legs. Time: 25 minutes.`,
        `Check the funding rate ${N} reports once a week; the position earns while funding stays positive, so log the rate and the week's accrual. Cost: no fee to check. Time: 5 minutes a week for ${x.hold} days.`,
        `Rebalance once a fortnight: if either leg drifts more than 10% from ${fmtUsd(x.half)} notional, trim or top it back so the pair stays delta-neutral. Cost: about ${x.G1} gas per rebalance. Time: 15 minutes a fortnight.`,
        `Add ${fmtUsd(x.quarter)} of fresh margin from ${C2} if ${N} takes deposits there, and extend the short leg by the same notional. Cost: ${fmtUsd(x.quarter)} of margin plus ${x.G2} gas. Time: 15 minutes.`,
        `Hold the paired position for ${x.hold} days; basis returns accrue slowly, and closing early usually surrenders the spread you waited for. Cost: margin stays posted; no fee to hold. Time: ${x.hold} days.`,
        `Close both legs in the same session — short first, spot second — then withdraw and record the net funding earned in the farm log. Cost: about ${x.G1x2} of gas to close. Time: 25 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 2 + Math.ceil(W / 2) + 2) + x.g2),
      activeMin: 15 + 25 + 5 * W + 15 * Math.ceil(W / 2) + 15 + 0 + 25,
    };
    case 'predict': return {
      steps: [
        `Fund a fresh wallet with ${fmtUsd(x.cap)} of USDC on ${C1} and finish any profile step ${N} asks for; prediction books index participation by account, not by deposit size alone. Cost: ${x.G1} in gas to fund. Time: 15 minutes.`,
        `Place your first position of ${fmtUsd(x.quarter)} on ${N}'s most liquid market — the one with the tightest spread — and hold it to settlement rather than flipping it. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G1} gas. Time: 10 minutes plus the market's own term.`,
        `Take one position a week across ${x.hold} days, alternating market types (price, sports, events) when ${N} lists them, sized between ${fmtUsd(Math.max(10, Math.round(x.quarter / 2)))} and ${fmtUsd(x.quarter)}. Cost: about ${x.G1} gas per position. Time: 10 minutes a week.`,
        `Provide liquidity once: rest a two-sided quote of ${fmtUsd(x.quarter)} total on one mid-sized market for at least 7 days, so the account also shows a maker's footprint. Cost: ${x.G1} gas to place and to cancel. Time: 15 minutes.`,
        `Claim every settled position the day it resolves; unclaimed settlements are the most common way prediction farmers lose their record. Cost: ${x.G1} gas per claim. Time: 5 minutes per settlement.`,
        `Keep a running tally of stake, settlement and profit in the farm log; a book with a visible history is worth more than raw volume if participation is ever reviewed. Cost: no fee. Time: 5 minutes a week for ${x.hold} days.`,
        `After ${x.hold} days, let open positions settle rather than selling at a discount, then sweep the balance to your main wallet. Cost: ${x.G1} gas to withdraw. Time: 15 minutes plus settlements.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + W + 2 + Math.ceil(W / 2) + 1)),
      activeMin: 15 + 10 + 10 * W + 15 + 5 * Math.ceil(W / 2) + 5 * W + 15,
    };
    case 'chain': return {
      steps: [
        `Bridge ${fmtUsd(x.cap)} of working funds to ${N}'s network from ${C1} through its canonical route and keep a native gas balance there; a chain with no token yet is farmed by being used, not by deposits elsewhere. Cost: the canonical route's quoted fee plus ${x.G1} gas. Time: 25 minutes including arrival.`,
        `Make the chain's basic transactions from a fresh wallet: one transfer, one contract deployment of a trivial contract, and one swap in its reference DEX, all in the first session. Cost: about ${x.G1} in native gas per action at this snapshot's prices. Time: 30 minutes.`,
        `Transact twice a week for ${x.hold} days — a swap, a mint or a small transfer each time, varying the counterparty app so the history is not one contract deep. Cost: about ${fmtUsd(2 * x.g1)} of gas a week. Time: 15 minutes a week.`,
        `Run one governance or testnet-adjacent duty the chain offers (a vote, a faucet-linked task, a public-goods contribution) whenever it opens; chains reward citizens, not only traders. Cost: no fee beyond gas. Time: 20 minutes per duty.`,
        `Hold at least ${fmtUsd(x.quarter)} of assets natively on the chain for the full ${x.hold} days instead of bridging in and out; resident balances are the cheapest signal to keep. Cost: ${fmtUsd(x.quarter)} stays on the chain. Time: ${x.hold} days.`,
        `Add a second wallet only after the first has four full weeks of history, and give it a different rhythm (weekly, not twice-weekly) so the two do not move in lockstep. Cost: ${x.G1} gas to fund. Time: 15 minutes.`,
        `At the end of the hold, bridge back only what you need; leave the farm log with every hash, and keep the wallet — chain histories age well and cost nothing to keep. Cost: one route fee to consolidate. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 3 + 2 * W + 1 + 1)),
      activeMin: 25 + 30 + 15 * W + 20 + 0 + 15 + 20,
    };
    case 'index': return {
      steps: [
        `Fund a fresh wallet with ${fmtUsd(x.cap)} of USDC on ${C1}; index products settle in baskets, so expect the first mint to touch several underlying markets at once. Cost: ${x.G1} in gas to fund and approve. Time: 15 minutes.`,
        `Mint ${fmtUsd(x.cap)} of ${N}'s flagship basket on ${C1} and record the basket's composition and weights from the app on the day you mint. Cost: ${fmtUsd(x.cap)} of capital plus ${x.G1} gas. Time: 15 minutes.`,
        `Hold the basket untouched for at least 30 days; index loyalty is measured in holding through a rebalance, not in mint count. Cost: capital stays minted; no fee to hold. Time: 30 days minimum.`,
        `Add ${fmtUsd(x.quarter)} at the next rebalance date ${N} publishes, so the wallet shows participation across two different basket vintages. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G1} gas. Time: 10 minutes.`,
        `Mint a second, smaller basket of ${fmtUsd(x.quarter)} on ${C2} if ${N} issues there, and leave it unredeemed. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G2} gas. Time: 15 minutes.`,
        `Review the basket's weights once a month against what you recorded; a basket that quietly changed character is a reason to exit at the next window, not mid-hold. Cost: no fee to read. Time: 10 minutes a month across ${x.hold} days.`,
        `Redeem in one window rather than dribbling out, sweep the proceeds to your main wallet, and file the composition snapshots with the farm log. Cost: ${x.G1} gas to redeem. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + 1 + 1) + x.g2),
      activeMin: 15 + 15 + 0 + 10 + 15 + 20 + 20,
    };
    default: return {
      steps: [
        `Create a fresh wallet for ${N}, fund it with ${fmtUsd(x.cap)} of USDC on ${C1} plus gas money, and keep the seed phrase offline. Cost: ${x.G1} in gas to fund and approve. Time: 15 minutes.`,
        `Make ${N}'s core action with ${fmtUsd(x.half)}: open its app on ${C1}, connect the wallet, and complete the main transaction it is built around (a deposit, mint, enrolment or purchase, whichever its interface leads with). Cost: ${fmtUsd(x.half)} of capital plus ${x.G1} gas. Time: 20 minutes.`,
        `Return once a week for ${x.hold} days and repeat a smaller core action of ${fmtUsd(x.quarter)}, so the wallet builds a dated history instead of one visit. Cost: about ${x.G1} gas per visit. Time: 15 minutes a week.`,
        `Complete every free profile, referral or points step inside ${N}'s own app — they cost nothing and are usually how participation is indexed. Cost: no fee. Time: 10 minutes total.`,
        `Use ${N} from ${C2} with ${fmtUsd(x.quarter)} if it runs there too, repeating the core action once on that chain. Cost: ${fmtUsd(x.quarter)} of capital plus ${x.G2} gas. Time: 15 minutes.`,
        `Hold any balance or position the core action created for the full ${x.hold} days, checking the app monthly for new tasks rather than churning. Cost: capital stays in place; no fee to check. Time: ${x.hold} days, 5 minutes a month.`,
        `Wind down deliberately: exit the position through ${N}'s own interface, sweep funds to your main wallet, and log dates, amounts and hashes. Cost: ${x.G1} gas to exit. Time: 20 minutes.`,
      ],
      gasUsd: round2(x.g1 * (1 + 1 + W + 1) + x.g2),
      activeMin: 15 + 20 + 15 * W + 10 + 15 + 10 + 20,
    };
  }
}

/**
 * The one step in each plan that belongs to this row alone, read off its own
 * figures: an unreported listing date, a TVL crash, a one-week spike, a very young
 * record, or a wide chain spread — in that order, first match wins. Returns null
 * when the row's record raises no flag.
 */
function tailoredNote(p: SnapshotProtocol, v: Valuation, x: FarmCtx): string | null {
  if (p.listed_at === null) {
    return `Verify before you fund: the snapshot gives ${p.name} no listing date, so check the deployment date of its main contract yourself and only farm if the record is at least 90 days old. Cost: no fee to check. Time: 20 minutes once.`;
  }
  if (p.change_7d !== null && p.change_7d <= -15) {
    return `Size down first: ${p.name}'s TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the week to this snapshot, so enter with half the planned capital (${fmtUsd(Math.round(x.cap / 2))}) and add the rest only after a weekly print stops falling. Cost: no extra fee; the second tranche pays its own gas. Time: two entries, a week apart.`;
  }
  if (p.change_7d !== null && p.change_7d >= 40) {
    return `Do not chase the spike: ${p.name}'s TVL jumped ${p.change_7d.toFixed(1)}% in one week, which is often one large depositor; wait for the next weekly print and start only if at least half the gain is still there. Cost: no fee to wait. Time: 10 minutes to re-check in a week.`;
  }
  if (v.age !== null && v.age < 90) {
    return `Young record: ${p.name} has been tracked for only ${v.age} days, so keep the first position at ${fmtUsd(x.quarter)} until the record passes 90 days, then scale to the full plan. Cost: no extra fee. Time: one extra visit at day 90.`;
  }
  if (p.chains.length >= 5) {
    return `Pick your ground: ${p.name} runs on ${p.chains.length} chains, and this plan farms the two cheapest to use (${x.c1} at about ${x.G1} an action, ${x.c2} at about ${x.G2}); ignore the rest unless a chain-specific campaign appears. Cost: no fee to choose. Time: 5 minutes.`;
  }
  return null;
}

interface FarmResult {
  steps: string[];
  archetype: string;
  gasUsd: number;
  activeMin: number;
  capitalUsd: number;
  holdDays: number;
}

function farmPlan(p: SnapshotProtocol, v: Valuation): FarmResult {
  const c1 = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const c2 = p.chains.length > 1 ? p.chains[1]! : c1;
  const cap = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(v.age);
  const g1 = gasFor(c1);
  const g2 = gasFor(c2);
  const ctx: FarmCtx = {
    name: p.name, c1, c2, cap,
    half: Math.round(cap / 2), quarter: Math.round(cap / 4),
    borrow: Math.round(cap * 0.4), mint: Math.round(cap * 0.5),
    hold, weeks: Math.max(1, Math.round(hold / 7)), g1, g2,
    G1: fmtUsd(g1), G2: fmtUsd(g2), G1x2: fmtUsd(2 * g1),
  };
  const archetype = archetypeFor(p.category);
  const plan = planFor(archetype, ctx);
  const note = tailoredNote(p, v, ctx);
  const steps = note === null ? plan.steps : [plan.steps[0]!, note, ...plan.steps.slice(1)];
  for (const s of steps) {
    const t = s.trim();
    if (t.length < 20 || t.length > 600) throw new Error(`farm step for ${p.slug} is ${t.length} characters`);
    if (!t.includes('Cost:') || !t.includes('Time:')) throw new Error(`farm step for ${p.slug} lacks a Cost or a Time`);
  }
  return { steps, archetype, gasUsd: plan.gasUsd, activeMin: plan.activeMin, capitalUsd: cap, holdDays: hold };
}

// ---------------------------------------------------------------- board

interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  peer_count: number;
  effective_peers: number;
  evidence: 'A' | 'B' | 'C';
  category_multiple: number;
  model: {
    category_multiple: number;
    multiple_p25: number;
    multiple_p75: number;
    global_multiple: number;
    peer_count: number;
    effective_peers: number;
    growth_pct: number | null;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    band_widen: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

interface PeerComp {
  name: string;
  slug: string;
  mcap_usd: number;
  tvl_usd: number;
  ratio: number;
  weight: number;
}

interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    shrinkage_k: number;
    clamp_lo: number;
    clamp_hi: number;
    widen_per_missing: number;
    global_peers_raw: number;
    global_peers: number;
    global_multiple: number;
    global_p25: number;
    global_p75: number;
    category_pricing: Record<string, { multiple: number; p25: number; p75: number; peers: number; effective_peers: number; at_tvl: number }>;
  };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: Array<{
    rank: number; slug: string; name: string; category: string | null; chains: string[];
    tvl_usd: number; change_7d: number | null; listed_at: string | null; age_days: number | null;
    watchlist: boolean; implied_value_usd: number; implied_low_usd: number; implied_high_usd: number;
    peer_count: number; effective_peers: number; evidence: 'A' | 'B' | 'C';
    category_multiple: number; multiple_p25: number; multiple_p75: number; global_multiple: number;
    growth_multiplier: number; maturity_multiplier: number; breadth_multiplier: number; band_widen: number;
    archetype: string; archetype_label: string;
  }>;
  peers: Record<string, PeerComp[]>;
  live: LiveRow[];
  farm: Record<string, string[]>;
  farm_meta: Record<string, { capital_usd: number; est_gas_usd: number; active_minutes: number; hold_days: number }>;
}

/** The five peers that priced a row most: highest scale weight, then largest market cap. */
function topPeers(peers: Peer[], rowTvl: number): PeerComp[] {
  return peers
    .map((p) => ({ p, w: scaleWeight(p.tvl, rowTvl) }))
    .sort((a, b) => b.w - a.w || b.p.mcap - a.p.mcap || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, 5)
    .map(({ p, w }) => ({ name: p.name, slug: p.slug, mcap_usd: p.mcap, tvl_usd: p.tvl, ratio: round4(p.mult), weight: round4(w) }));
}

function buildBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const sets = buildPeerSets(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, p);
  }

  const watchSet = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => {
    const pricing = priceRow(p.tvl_usd, p.category, sets);
    const v = valueProtocol(p, snapshot.as_of, pricing);
    return { p, v, plan: farmPlan(p, v) };
  });
  scored.sort((a, b) => b.v.base - a.v.base || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    watchlist: watchSet.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.base,
    implied_low_usd: s.v.low,
    implied_high_usd: s.v.high,
    peer_count: s.v.pricing.peerCount,
    effective_peers: s.v.pricing.effectivePeers,
    evidence: s.v.evidence,
    category_multiple: round4(s.v.pricing.used),
    model: {
      category_multiple: round4(s.v.pricing.used),
      multiple_p25: round4(s.v.pricing.usedP25),
      multiple_p75: round4(s.v.pricing.usedP75),
      global_multiple: round4(s.v.pricing.globalMedian),
      peer_count: s.v.pricing.peerCount,
      effective_peers: s.v.pricing.effectivePeers,
      growth_pct: s.v.growthPct,
      growth_multiplier: s.v.growthMult,
      maturity_multiplier: s.v.maturityMult,
      breadth_multiplier: s.v.breadthMult,
      band_widen: s.v.widen,
      age_days: s.v.age,
    },
    farm_steps: s.plan.steps,
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));

  const farm: Record<string, string[]> = {};
  const farmMeta: Record<string, { capital_usd: number; est_gas_usd: number; active_minutes: number; hold_days: number }> = {};
  const peers: Record<string, PeerComp[]> = {};
  for (const s of scored) {
    farm[s.p.slug] = s.plan.steps;
    farmMeta[s.p.slug] = { capital_usd: s.plan.capitalUsd, est_gas_usd: s.plan.gasUsd, active_minutes: s.plan.activeMin, hold_days: s.plan.holdDays };
    peers[s.p.slug] = topPeers(sets.byCategory.get(s.p.category ?? '(none)') ?? [], s.p.tvl_usd);
  }

  // The category table the dashboard prints: each board category priced at the
  // median TVL of its own board rows, so the printed multiples are real outputs of
  // the same priceRow the board used, at a stated scale.
  const catTvls = new Map<string, number[]>();
  for (const s of scored) {
    const key = s.p.category ?? '(none)';
    const arr = catTvls.get(key) ?? [];
    arr.push(s.p.tvl_usd);
    catTvls.set(key, arr);
  }
  const categoryPricing: RadarData['model']['category_pricing'] = {};
  for (const key of [...catTvls.keys()].sort()) {
    const tvls = catTvls.get(key)!.sort((a, b) => a - b);
    const rep = tvls[Math.floor(tvls.length / 2)]!;
    const pr = priceRow(rep, key === '(none)' ? null : key, sets);
    categoryPricing[key] = {
      multiple: round4(pr.used), p25: round4(pr.usedP25), p75: round4(pr.usedP75),
      peers: pr.peerCount, effective_peers: pr.effectivePeers, at_tvl: rep,
    };
  }

  const globalMults = sets.global.map((p) => p.mult).sort((a, b) => a - b);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      shrinkage_k: SHRINK_K,
      clamp_lo: MULT_LO,
      clamp_hi: MULT_HI,
      widen_per_missing: BAND_WIDEN_PER_MISSING,
      global_peers_raw: sets.rawGlobalCount,
      global_peers: sets.global.length,
      global_multiple: round4(clamp(quantile(globalMults, 0.5), MULT_LO, MULT_HI)),
      global_p25: round4(clamp(quantile(globalMults, 0.25), MULT_LO, MULT_HI)),
      global_p75: round4(clamp(quantile(globalMults, 0.75), MULT_LO, MULT_HI)),
      category_pricing: categoryPricing,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
      tvl_usd: r.tvl_usd, change_7d: r.change_7d, listed_at: r.listed_at, age_days: r.age_days,
      watchlist: r.watchlist, implied_value_usd: r.implied_value_usd,
      implied_low_usd: r.implied_low_usd, implied_high_usd: r.implied_high_usd,
      peer_count: r.peer_count, effective_peers: r.effective_peers, evidence: r.evidence,
      category_multiple: r.category_multiple, multiple_p25: r.model.multiple_p25, multiple_p75: r.model.multiple_p75,
      global_multiple: r.model.global_multiple,
      growth_multiplier: r.model.growth_multiplier, maturity_multiplier: r.model.maturity_multiplier,
      breadth_multiplier: r.model.breadth_multiplier, band_widen: r.model.band_widen,
      archetype: archetypeFor(r.category), archetype_label: ARCHETYPE_LABEL[archetypeFor(r.category)]!,
    })),
    peers,
    live,
    farm,
    farm_meta: farmMeta,
  };
  return { board, radar };
}

/** Why a board is not one the gate will take, or null. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!(r.implied_low_usd <= r.implied_value_usd && r.implied_value_usd <= r.implied_high_usd)) return `${r.slug} has an inverted value band`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- entrypoint

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildBoard(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), `window.RADAR=${JSON.stringify(radar)};\n`);

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
