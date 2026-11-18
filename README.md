# The Lahore Canyon · GIS Day 2026

**Live app:** https://muhammad-mehdi12.github.io/lahore-canyon/

Heat maps stop at the ground. This one climbs every wall of Lahore's Walled City, hour by hour through the hottest day of 2026 (10 June), then stays out on the worst smog night (10 November) to ask why the air won't leave. DHA Phase 2 is the comparison tile.

Built for GIS Day 2026 (18 November), theme *GIS: Powering Purpose and Innovation*.

**Heat has an address. GIS finds it.**

Developed by **Muhammad Mehdi** & **Hussain Ahmad**, BS Geography, 7th Semester (Morning).

## What's inside
- 3D model of two 1.2 × 1.2 km tiles on a 4 m grid; every wall split into storey-high panels (189,090 in the Walled City)
- Hourly sun/shade by ray marching, sky view factor, and a surface energy balance per surface
- 14-scene guided walkthrough, floor-by-floor building briefs, what-if scenarios (cool roofs, street shade) recomputed in the browser, and a "where to act first" ranking
- Checked against two satellites: Landsat 8 at 10:35 am (model 51.3 °C vs 51.6 °C measured, Walled City) and MODIS Aqua at night (28.5 °C vs 27.1 °C). In the afternoon MODIS (1 km) reads much cooler than the model, so the app shows only measured temperatures in degrees and uses the model to compare surfaces (hotter or cooler)

- The sun is drawn in the 3D scene with its path for the day; shadows follow the hour slider

## Data
- Building heights: Google Open Buildings 2.5D Temporal (2023)
- Surface temperature & NDVI: Landsat 8 Collection 2 Level-2, via Microsoft Planetary Computer
- Afternoon and night surface temperature check: MODIS Aqua/Terra MOD11A1/MYD11A1 v061, via Microsoft Planetary Computer
- Hourly weather & boundary-layer height: ERA5 via Open-Meteo
- PM2.5: CAMS (modelled) via Open-Meteo
- Landmark names: © OpenStreetMap contributors

## Repository
- `index.html` — the complete app, single self-contained file (works offline)
- `source/model` — Python model, validation and calibration
- `source/app` — app source (three.js, bundled with esbuild)
- `source/data` — processed input data

Limits are listed in the app under **Data & method**.

## Data and dates used

| What | Source | Date / period | Type |
|---|---|---|---|
| Building heights | Google Open Buildings 2.5D Temporal | 2023 layer, 4 m | Satellite-derived |
| Ground surface temperature, green cover | Landsat 8 C2 L2, scene LC08_L2SP_149038_20260607 | 7 Jun 2026, 10:35 am PKT, 30 m | Measured |
| Ground surface temperature | MODIS Aqua MYD11A1 v061 | 10 Jun 2026, 2:48 pm and 4:30 am, 1 km | Measured |
| Air temperature, sunshine, wind, mixing height | ERA5 via Open-Meteo | hourly, 1 Nov 2025 – 10 Nov 2026 | Weather record |
| PM2.5 | CAMS model via Open-Meteo | hourly, 1 Nov 2025 – 13 Nov 2026 | Model (not a station) |
| Sun, shade, hours of sun, open sky | Calculated from building heights and sun position | 10 Jun and 10 Nov 2026 | Calculated |
| White-roof estimate | Energy-balance model in this app | 10 Jun 2026 | Model |
