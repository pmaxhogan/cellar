# Cellar color system

The definitive palette for Cellar. Dark-first: the dark UI is the good one and the
light UI is a correct, unembarrassing fallback. The source of truth for every value is
`web/src/theme/cellar-preset.ts`; this file explains the values and records their
measured contrast.

Every ratio below is the WCAG 2.x contrast ratio, computed with the relative-luminance
formula by `web/test/helpers/contrast.ts` (not estimated). `web/test/palette.test.ts`
re-measures the load-bearing pairs on every test run, so a palette edit that breaks one
fails CI. Thresholds: 4.5:1 for normal text (AA), 3:1 for large text and for non-text UI
such as focus rings and input outlines (WCAG 1.4.11), 7:1 for AAA body text.

Two rules drive everything else:

1. Wine is a dark hue. No single step of the scale can both carry white text and read
   as text on the dark page. So dark mode splits the job: `primary.color` is the light
   primary-400 (links, accents, focus ring, small filled controls with near-black wine
   text), while the filled primary Button uses deep wine 500 -> 600 -> 700 with white
   text.
2. Light mode uses 700 / 800 / 900 with white text everywhere.

---

## Wine primary scale

| Token       | Hex       | Role                                                            |
| ----------- | --------- | --------------------------------------------------------------- |
| primary-50  | `#fdf2f4` | light: active nav item wash                                     |
| primary-100 | `#fbe4e9` | light: highlight (selected row) background                      |
| primary-200 | `#f6c8d3` | light: highlight focus background; dark: pressed small fill     |
| primary-300 | `#ee9fb2` | dark: hover small fill, active nav text, highlight text         |
| primary-400 | `#e2738e` | dark: `primary.color` (accent text, links, focus ring)          |
| primary-500 | `#c4405f` | the brand color; dark: filled Button at rest                    |
| primary-600 | `#ad3352` | dark: filled Button hover                                       |
| primary-700 | `#8e2643` | light: `primary.color` and filled Button; dark: Button pressed |
| primary-800 | `#701e36` | light: Button hover                                             |
| primary-900 | `#58182b` | light: Button pressed, highlight text                           |
| primary-950 | `#330b18` | light: highlight focus text; favicon cork                       |

On-primary for light fills in dark mode: `#2a0a15` (near-black wine).

## Surface scale (neutral with a trace of wine)

| Token       | Hex       | Role                                                    |
| ----------- | --------- | ------------------------------------------------------- |
| surface-0   | `#ffffff` | light: card, field background                           |
| surface-50  | `#faf7f8` | light: page background                                  |
| surface-100 | `#f3eef0` | light: hover background                                 |
| surface-200 | `#e7dee2` | light: decorative border                                |
| surface-300 | `#d4c7cd` | light: strong decorative border                         |
| surface-400 | `#a9989f` | light: disabled text (exempt, never load-bearing)       |
| surface-500 | `#86757d` | light: icons; dark: field hover outline                 |
| surface-600 | `#6b5a62` | light: subtle text, placeholder, field hover outline    |
| surface-700 | `#4f4149` | light: muted text                                       |
| surface-800 | `#352b31` | dark: filled field hover                                |
| surface-900 | `#1f181c` | dark: card, sidebar, field background; light: body text |
| surface-950 | `#151013` | dark: page background                                   |

Dark-only roles between steps:

| Role                              | Hex       |
| --------------------------------- | --------- |
| elevated (menus, popovers, hover) | `#2a2126` |
| border (decorative)               | `#3b3036` |
| text                              | `#f5eef1` |
| text muted                        | `#bba9b1` |
| text subtle (placeholder, icons)  | `#9a8892` |

Form-field outlines (`cellarFieldBorder`): light `#8f7e86`, dark `#7a6971`.

Layering in dark mode: page `#151013` -> card `#1f181c` -> elevated `#2a2126`. Each step
is a lift in lightness, not a shadow.

---

## Text on surfaces, measured

### Dark mode

| Text                        | Hex       | on page `#151013` | on card `#1f181c` | on elevated `#2a2126` |
| --------------------------- | --------- | ----------------- | ----------------- | --------------------- |
| text                        | `#f5eef1` | 16.48             | 15.25             | 13.68                 |
| text muted                  | `#bba9b1` | 8.45              | 7.82              | 7.01                  |
| text subtle                 | `#9a8892` | 5.66              | 5.23              | 4.70                  |
| primary-400 (accent, links) | `#e2738e` | 6.34              | 5.87              | 5.27                  |
| primary-300                 | `#ee9fb2` | 9.18              | 8.49              | 7.62                  |
| primary-500                 | `#c4405f` | 3.81              | 3.52              | 3.16                  |
| disabled (surface-600)      | `#6b5a62` | 2.93              | 2.71              | 2.43                  |

primary-500 is never used as text in dark mode: it clears 3:1 only, which is enough for a
filled shape but not for words. Disabled text is exempt under WCAG and is never the only
carrier of meaning.

### Light mode

| Text                        | Hex       | on page `#faf7f8` | on card `#ffffff` | on hover `#f3eef0` |
| --------------------------- | --------- | ----------------- | ----------------- | ------------------ |
| text (surface-900)          | `#1f181c` | 16.36             | 17.42             | 15.18              |
| text muted (surface-700)    | `#4f4149` | 9.03              | 9.61              | 8.38               |
| text subtle (surface-600)   | `#6b5a62` | 6.04              | 6.43              | 5.61               |
| primary-700 (accent, links) | `#8e2643` | 7.86              | 8.37              | 7.29               |
| icons (surface-500)         | `#86757d` | 4.06              | 4.33              | 3.77               |
| disabled (surface-400)      | `#a9989f` | 2.57              | 2.73              | 2.38               |

---

## Primary button and fills, measured

### Dark mode

| Fill                  | State                         | Text      | Ratio |
| --------------------- | ----------------------------- | --------- | ----- |
| primary-500 `#c4405f` | filled Button, rest           | `#ffffff` | 4.95  |
| primary-600 `#ad3352` | filled Button, hover          | `#ffffff` | 6.23  |
| primary-700 `#8e2643` | filled Button, pressed        | `#ffffff` | 8.37  |
| primary-400 `#e2738e` | small filled control, rest    | `#2a0a15` | 6.14  |
| primary-300 `#ee9fb2` | small filled control, hover   | `#2a0a15` | 8.88  |
| primary-200 `#f6c8d3` | small filled control, pressed | `#2a0a15` | 12.25 |

White on primary-400 measures 2.97 and fails, which is why `primary.contrastColor` is
`#2a0a15` in dark mode and why the Button gets its own deeper ladder. Do not "fix" either.

The Button fill itself against its surroundings (non-text, 3:1 needed): primary-500 is
3.81 on the page and 3.52 on a card.

### Light mode

| Fill                  | State                  | Text      | Ratio |
| --------------------- | ---------------------- | --------- | ----- |
| primary-700 `#8e2643` | filled Button, rest    | `#ffffff` | 8.37  |
| primary-800 `#701e36` | filled Button, hover   | `#ffffff` | 10.89 |
| primary-900 `#58182b` | filled Button, pressed | `#ffffff` | 13.29 |

---

## Non-text UI, measured

| Element                  | Pair                                              | Ratio              |
| ------------------------ | ------------------------------------------------- | ------------------ |
| focus ring, dark         | primary-400 on page / card                        | 6.34 / 5.87        |
| focus ring, light        | primary-700 on page / card                        | 7.86 / 8.37        |
| field outline, dark      | `#7a6971` on field `#1f181c` / elevated `#2a2126` | 3.39 / 3.04        |
| field outline, light     | `#8f7e86` on field `#ffffff` / page `#faf7f8`     | 3.82 / 3.59        |
| decorative border, dark  | `#3b3036` on card                                 | 1.38 (divider only) |
| decorative border, light | surface-300 on white                              | 1.63 (divider only) |

The decorative borders separate regions that are already separated by background; they
never identify a control. Inputs use the field outline instead.

## Tinted states, measured

Translucent fills are measured after compositing over the surface they sit on.

| Element                | Text on fill                                                    | Ratio |
| ---------------------- | --------------------------------------------------------------- | ----- |
| active nav item, dark  | primary-300 on `rgba(196, 64, 95, 0.16)` over card (`#391e27`) | 7.37  |
| highlight, dark        | primary-300 on `rgba(196, 64, 95, 0.18)` over card (`#3d1f28`) | 7.18  |
| highlight focus, dark  | primary-200 on `rgba(196, 64, 95, 0.28)` over card (`#4d232f`) | 8.84  |
| active nav item, light | primary-700 on primary-50                                       | 7.65  |
| highlight, light       | primary-900 on primary-100                                      | 10.99 |
| highlight focus, light | primary-950 on primary-200                                      | 11.75 |

---

## Semantic colors

Not part of PrimeVue's semantic token set, so `web/src/assets/main.css` exposes them as
`--cellar-*` custom properties. Error sits near the brand hue, so an error state always
carries an icon and a text label: color alone is never the signal.

| Role    | Light     | on page / card | Dark      | on page / card |
| ------- | --------- | -------------- | --------- | -------------- |
| success | `#1e7a47` | 5.02 / 5.34    | `#57b87a` | 7.66 / 7.09    |
| warn    | `#8f6304` | 4.99 / 5.31    | `#f2ce4b` | 12.29 / 11.37  |
| error   | `#b8322a` | 5.59 / 5.95    | `#ef6b5e` | 6.22 / 5.75    |
| info    | `#1f6fb2` | 4.96 / 5.28    | `#6aa9e0` | 7.50 / 6.94    |

On their tinted backgrounds: light warn on `#faf1d8` 4.71, light error on `#fbe9e7`
5.08, dark warn on `#2b2410` 10.06, dark error on `#2e1512` 5.63.

## Insecure-mode banner

Brick red, deliberately outside the wine scale so it can never read as brand chrome:
text `#fff1ee` on `#7a1d12` measures 9.48, with a `#ef6b5e` bottom rule.

## Public share page

`web/src/share/share.css` restates the palette as plain custom properties because the
share bundle loads no PrimeVue. It follows the OS color scheme, dark by default.

| Role        | Dark                | Light               |
| ----------- | ------------------- | ------------------- |
| background  | `#151013`           | `#faf7f8`           |
| text        | `#f5eef1` (16.48)   | `#1f181c` (16.36)   |
| muted       | `#bba9b1` (8.45)    | `#4f4149` (9.03)    |
| accent rule | `#e2738e` (6.34)    | `#8e2643` (7.86)    |

## Favicon

`web/public/favicon.svg`: a wine bottle. Body primary-700 `#8e2643` with a primary-400
`#e2738e` rim so the silhouette survives both a dark and a white tab strip, a
primary-950 `#330b18` cork, and a primary-200 `#f6c8d3` label that keeps it a bottle
rather than a blob at 16 px.
