# Nextra logo concepts

> **Final decision:** Union N · Aurora, hot palette (`union-aurora/36f-hot.svg`)
> was chosen and productionized. The shipped sources live in `public/brand/*.svg`;
> all `public/icons/` PNGs, both `.ico` files, and the brand PNGs are generated
> from them. This folder keeps only the winning direction's family.

The mark: two strokes, one from each side, overlapping mid-diagonal in a white-hot
point — the N only exists because the two sides meet. Cyan→blue from the host side,
magenta→violet from the viewer side, on a deluxe gradient tile.

Forty exploration concepts across eight batches preceded this and were removed on
2026-08-04; they remain in git history at commit `84b1634` if a direction is ever
worth revisiting.

## Union N · Aurora family (`union-aurora/`)

Open `union-aurora/preview-union-aurora.html` in a browser to compare the variants
on dark and light backgrounds, including navbar/dock/favicon mocks.

| Variant | File | Recipe |
|---------|------|--------|
| 36a | `union-aurora/36a-refined.svg` | Baseline, tuned: longer overlap, balanced terminals, white core on cyan bloom. |
| 36b | `union-aurora/36b-spark.svg` | Strands stop short; a four-point sparkle bridges the gap. |
| 36c | `union-aurora/36c-bare.svg` | No tile — the mark alone for navbar/README use. |
| 36d | `union-aurora/36d-mono.svg` | Strictly the app's current blues; quieter, corporate. |
| 36e | `union-aurora/36e-bold.svg` | Heavier stems, stronger glow; maximum dock presence. |
| **36f** | `union-aurora/36f-hot.svg` | **Shipped.** Cyan→blue meets magenta→violet; loudest contrast. |
| favicon | `union-aurora/36-favicon.svg` | Dedicated 32 px-grid cut with simplified geometry. |

Five alternates explore the hot palette:

| Variant | File | Recipe |
|---------|------|--------|
| 36f1 | `union-aurora/36f1-neon.svg` | **Neon** — electric cyan vs hot pink on a near-black tile, maximum glow. |
| 36f2 | `union-aurora/36f2-sunset.svg` | **Sunset** — amber→coral meets violet→rose; warm movie-night take. |
| 36f3 | `union-aurora/36f3-ultra.svg` | **Ultra** — hot pair plus chromatic echoes: each strand throws a shifted ghost of the other's color. |
| 36f4 | `union-aurora/36f4-spark.svg` | **Spark** — hot palette with the sparkle-gap treatment: white star in a pink bloom bridges the strands. |
| 36f5 | `union-aurora/36f5-bare.svg` | **Bare** — the hot mark without the tile, for navbar/README use. |

Changing the shipped mark means replacing `public/brand/*.svg` and regenerating
`public/icons/` via `scripts/generate-icons.ps1`.
