# FieldPulse App Icon Spec — Concept 2F (Hex Pin Combo)

## Canvas
- Size: 1024 × 1024 px
- Background: `#faf9f6`
- Android adaptive icon foreground: center content in safe zone (812×812 inner area)

## Hexagon Mark

### Shape
Orientation: pointy-top (vertex at top and bottom)
Center: (512, 490)
Radius (center to vertex): 310 px

### Vertices
| Point | X      | Y      |
|-------|--------|--------|
| Top   | 512    | 180    |
| TR    | 780.6  | 335    |
| BR    | 780.6  | 645    |
| Bot   | 512    | 800    |
| BL    | 243.4  | 645    |
| TL    | 243.4  | 335    |

SVG path: `M512,180 L780.6,335 L780.6,645 L512,800 L243.4,645 L243.4,335 Z`

Fill: `#1a1c1a`

## Map Pin Cutout (negative space — evenodd compound path)

Circle center: (512, 430)
Circle radius: 98 px

Top of circle: (512, 332)
Right tangent point (≈120° from top): (596.8, 479)
Left tangent point: (427.2, 479)
Tip: (512, 665)

SVG path (appended to hex path, same `<path>` element):
`M512,332 A98,98 0 0,1 596.8,479 L512,665 L427.2,479 A98,98 0 0,1 512,332 Z`

Full compound path with `fill-rule="evenodd"`:
```
M512,180 L780.6,335 L780.6,645 L512,800 L243.4,645 L243.4,335 Z
M512,332 A98,98 0 0,1 596.8,479 L512,665 L427.2,479 A98,98 0 0,1 512,332 Z
```

## ECG / Pulse Line

Drawn inside pin circle area (x: 415–610, y baseline: 430)
Color: `#1a1c1a`
Stroke width: 14 px
Stroke linecap: round
Stroke linejoin: round

Path:
`M415,430 L447,430 L463,375 L479,485 L495,430 L512,414 L528,446 L544,430 L610,430`

## Shadow Oval

Ellipse below hex:
cx: 512, cy: 842
rx: 130, ry: 20
Fill: `#695d4a`
Opacity: 35%

## Wordmark

Font: DM Sans ExtraBold (weight 800) — or heaviest available
Case: UPPERCASE
Size: ~108 px
Letter spacing: 8 px
Position: centered below mark, ~40 px below shadow oval (≈ y 920 baseline)

FIELD: fill `#1a1c1a`
PULSE: fill `#695d4a`
Render as two adjacent text spans with no gap.

## app.json icon paths

```json
"icon": "./assets/icon.png",
"android": {
  "adaptiveIcon": {
    "foregroundImage": "./assets/adaptive-icon.png",
    "backgroundColor": "#faf9f6"
  }
}
```

Replace `backgroundColor` from `#1a1c1a` to `#faf9f6` in app.json when the new icon is exported.

## Export instructions

1. Build in Figma / Illustrator at 1024×1024
2. Export `icon.png` (1024×1024, PNG, no transparency)
3. Export `adaptive-icon.png` (1024×1024, foreground only, transparent bg)
4. Replace `./assets/icon.png` and `./assets/adaptive-icon.png`
5. Run `npx expo prebuild` to regenerate native assets
