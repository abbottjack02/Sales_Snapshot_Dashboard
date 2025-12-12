# Sales_Snapshot_Dashboard

CoffeeShopMVP is a lightweight, client-only React + TypeScript app that turns Square “Sales Summary” CSV exports into clear diagnostic signals for coffee shop owners. It aggregates data by day, normalizes by operating vs calendar days, and highlights what actually changed—volume, ticket size, discounts, or behavior.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed local URL in your browser. Drag a Square "Sales Summary" CSV onto the drop zone (or use the browse button) to generate per-day metrics and interpretation signals.

## What it does

- Heuristically detects date and numeric metric columns in Square CSV exports
- Cleans currency/percent strings and aggregates rows into per-day buckets
- Normalizes performance by operating days vs calendar days
- Computes per-day metrics and ratios: gross, net, discounts, tips, transactions
- Surfaces blunt signals about whether volume, ticket size, discounts, or tips are leading the change
