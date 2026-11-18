# token-radar-03

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/bimasetmuse61/token-radar-03/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/bimasetmuse61/token-radar-03/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar (model **radar-4**) for make.fun's `token-radar-01` bounty: a
Node 22 program, standard library only, that reads the sealed DefiLlama snapshot,
ranks the protocols that record no token by an implied token value derived only
from the snapshot's own figures, gives each a farm plan with a budget, and renders
it all as a static dashboard. Repository anchor: makefun anchor 7334d89cd385e9fd35b824053a8e28abc122e39f round 34068705

## The model (radar-4)

`implied = TVL × multiple × growth × maturity × breadth`, run at three multiples
for a low / base / high band on every row.

- **Peer hygiene.** A trading peer records a token (market cap present, TVL above
  zero) and is launch-comparable: not CEX category, not a name beginning with an
  exchange's, and no whole word *wrapped / staked / staking*. Exchange tokens and
  wrapped-asset mirrors never price a row.
- **Outlier trim.** In any peer set of 8+, multiples outside the set's own
  P10–P90 are set aside before quartiles are taken (the raw global set reaches a
  400× multiple).
- **Scale-matched weighting.** Peer weight for a row is
  `1 / (1 + |log10(peer TVL / row TVL)|)`; category P25 / median / P75 are weighted
  quantiles, so a $60M protocol is priced by $10M–$600M launches, not by a $40B one.
- **Shrinkage by effective peers.** `nEff = (Σw)² / Σw²` replaces the raw count in
  `used = (nEff × category + 4 × global) / (nEff + 4)`, per quartile, clamped to
  [0.03, 1.50]. A category with no peers is priced on the global weighted quartiles.
- **Growth, concave.** `1 + 0.55 × sign(g) × √(|g|/100)`, `g = clamp(7d change,
  −60%, +200%)` — a one-week +4,448% spike (this snapshot has one) must not mint
  rank; a steady +25% week counts for real. Unreported change is neutral.
- **Maturity, log-age.** `0.70 + 0.30 × ln(1 + age/365) / ln 5`, capped at four
  years; unknown age counts as 365 days.
- **Breadth.** `1 + min(chains − 1, 9) × 0.01`.
- **Uncertainty shown, not hidden.** Each unreported field (7d change, listing
  date) widens the band by 20% per side; the base never moves. Each row carries an
  evidence grade (A/B/C) from its effective peer count and data completeness.

The board holds every watchlist slug (40) plus every rankable pre-token protocol
below the $50M floor — 213 rows on this snapshot. Protocols whose token already
trades are never ranked; the dashboard shows them separately at real market caps.

## Farm plans

Fourteen archetypes (swap volume, supply & borrow, mint & repay, trading volume,
deposit & tend, vault curator, bridge routes, stake cycle, onboarding, basis pair,
prediction book, network use, index basket, active use), each with its own action
sequence and cadence. Gas is priced per chain from a cost table, capital is sized
by TVL tier, and the hold is a quarter of the protocol's tracked age, clamped to
30–120 days. One step per plan is tailored to the row itself — a falling TVL, a
one-week spike, an unknown listing date, a young record or a wide chain spread —
and every plan's budget (total gas, active minutes, capital, hold) is summed from
its own steps and printed above it in the detail view.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Outputs land in `out/`: `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` (written with `buildDossier` from `vendor/makefun-board.ts`, the
kit's library, shipped byte-for-byte). The program is deterministic: two runs on
the same snapshot write identical bytes.

## Layout

- `main.ts` — snapshot parsing, the radar-4 model, farm plans, board + dossier output.
- `dashboard/` — the static page (index.html, app.css, app.js); renders `../data.js`.
- `screenshots/` — board, detail and filtered views captured from the built page.
- `vendor/makefun-board.ts` — the scorer's dossier library, unmodified.

---
<sub>Entered on [make.fun](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
