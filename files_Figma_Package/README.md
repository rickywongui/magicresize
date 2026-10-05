# Banner Resizer — Figma Plugin

Duplicate your master banner frame to any size in one click.

## Files
```
banner-resizer/
├── manifest.json   ← plugin config
├── code.js         ← plugin logic (runs in Figma sandbox)
└── ui.html         ← plugin UI (iframe)
```

## Setup in Figma

1. Open Figma Desktop
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Select the `manifest.json` file from this folder
4. The plugin is now available under **Plugins → Development → Banner Resizer**

## How to use

### 1. Name your master banner
Give your master frame/component a name that contains the word **"Master"**
(e.g. `Master Banner`, `Master – 1920×1080`).

If no frame with "Master" in the name is found, the plugin falls back to the
**first frame on the current page**.

### 2. Set up Auto Layout (recommended)
Your master banner should already use Auto Layout for the internal layers
(headline, logo, tagline, button, product PNG, background image).
This ensures layers reflow automatically when the frame is resized.

### 3. Run the plugin
- Pick a **preset size** (8 standard ad / social formats are built in), or
- Enter a **custom width & height** in px, and optionally a label.
- Click **Create banner** — a duplicate appears on the canvas, scaled and
  positioned below the master.
- Use **⚡ Create all presets** to generate all 8 sizes at once.

## Scaling logic

| Layer type | What happens |
|---|---|
| Auto Layout containers | Resized by the root resize; children reflow automatically |
| Absolute-position children | `x`, `y` scaled proportionally |
| Shapes, vectors, images | `width`, `height` scaled proportionally |
| Text nodes | `fontSize` (and pixel `lineHeight`) scaled by `min(ratioX, ratioY)` |

## Tips

- Keep your background image as a **Fill** on the frame, not a child frame —
  Figma stretches fills automatically when the frame resizes.
- Product PNGs placed as **absolute** children will be repositioned and
  resized proportionally.
- After generation you can tweak any layer; the master is never modified.
