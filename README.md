# The Lahore Canyon · GIS Day 2026

**Live app:** https://muhammad-mehdi12.github.io/lahore-canyon/

Heat maps stop at the ground. This one climbs every wall of Lahore's Walled City, hour by hour through the hottest day of 2026 (10 June), then stays out on the worst smog night (10 November) to ask why the air won't leave. DHA Phase 2 is the comparison tile.

Built for GIS Day 2026 (18 November), theme *GIS: Powering Purpose and Innovation*.

## What's inside
- 3D model of two 1.2 × 1.2 km tiles on a 4 m grid; every wall split into storey-high panels (189,090 in the Walled City)
- Hourly sun/shade by ray marching, sky view factor, and a surface energy balance per surface
- 14-scene guided walkthrough, floor-by-floor building briefs, what-if scenarios (cool roofs, street shade) recomputed in the browser, and a "where to act first" ranking
- Checked against Landsat 8 surface temperature (7 Jun 2026): bias +0.7 °C (Walled City), −0.1 °C (DHA)

## Data
- Building heights: Google Open Buildings 2.5D Temporal (2023)
- Surface temperature & NDVI: Landsat 8 Collection 2 Level-2, via Microsoft Planetary Computer
- Hourly weather & boundary-layer height: ERA5 via Open-Meteo
- PM2.5: CAMS (modelled) via Open-Meteo
- Landmark names: © OpenStreetMap contributors

## Repository
- `index.html` — the complete app, single self-contained file (works offline)
- `source/model` — Python model, validation and calibration
- `source/app` — app source (three.js, bundled with esbuild)
- `source/data` — processed input data

Limits are listed in the app under **Data & method**.
