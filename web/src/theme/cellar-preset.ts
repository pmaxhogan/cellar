import { definePreset } from "@primeuix/themes";
import Aura from "@primeuix/themes/aura";

/**
 * Cellar - PrimeVue 4 theme preset.
 *
 * Dark-first, deep wine. docs/brand/palette.md holds the measured contrast
 * ratio behind every value here, and test/palette.test.ts re-measures the
 * load-bearing pairs. Four constraints matter:
 *
 *  - Wine is a dark hue. No single step can both carry white text (needs
 *    luminance below 0.18) and read as text on the dark page (needs above
 *    0.20), so dark mode splits the job: primary.color is the light
 *    primary-400 for accents, links, the focus ring and small filled controls
 *    (with a near-black wine contrastColor), while the filled Button gets its
 *    own deep-wine ladder 500 -> 600 -> 700 with white text.
 *  - Light mode uses 700/800/900 with white text everywhere.
 *  - Token references point at {primary.*} and {surface.*}, never at an Aura
 *    stock primitive such as {rose.*} or {pink.*}.
 *  - The focus ring follows {primary.color}: Aura declares focusRing outside
 *    colorScheme, so one reference has to be legal in both schemes.
 */

/** Wine primary scale. */
export const cellarPalette = {
  50: "#fdf2f4",
  100: "#fbe4e9",
  200: "#f6c8d3",
  300: "#ee9fb2",
  400: "#e2738e",
  500: "#c4405f",
  600: "#ad3352",
  700: "#8e2643",
  800: "#701e36",
  900: "#58182b",
  950: "#330b18",
} as const;

/** Neutrals with a trace of wine. Shared by both color schemes. */
export const cellarSurface = {
  0: "#ffffff",
  50: "#faf7f8",
  100: "#f3eef0",
  200: "#e7dee2",
  300: "#d4c7cd",
  400: "#a9989f",
  500: "#86757d",
  600: "#6b5a62",
  700: "#4f4149",
  800: "#352b31",
  900: "#1f181c",
  950: "#151013",
} as const;

/** Dark-scheme roles that sit between surface steps. */
export const cellarDark = {
  elevated: "#2a2126",
  border: "#3b3036",
  text: "#f5eef1",
  textMuted: "#bba9b1",
  textSubtle: "#9a8892",
  onPrimary: "#2a0a15",
} as const;

/**
 * Form-field outlines. The general border colors are decorative dividers (1.4:1
 * to 1.6:1); an input boundary is what identifies the control, so it gets its
 * own value that clears the WCAG 1.4.11 non-text minimum of 3:1 against the
 * field background.
 */
export const cellarFieldBorder = {
  light: "#8f7e86",
  dark: "#7a6971",
} as const;

/**
 * Semantic colors, per scheme. Not part of PrimeVue's semantic token set, so
 * main.css exposes them as --cellar-* custom properties.
 *
 * error sits near the brand hue. Error states always carry an icon and a text
 * label; color alone is never the signal.
 */
export const cellarSemantic = {
  light: {
    success: "#1e7a47",
    warn: "#8f6304",
    error: "#b8322a",
    info: "#1f6fb2",
  },
  dark: {
    success: "#57b87a",
    warn: "#f2ce4b",
    error: "#ef6b5e",
    info: "#6aa9e0",
    successBg: "#152a1d",
    successBorder: "#255c3a",
    warnBg: "#2b2410",
    warnBorder: "#6b5a16",
    errorBg: "#2e1512",
    errorBorder: "#73302a",
    infoBg: "#141f2c",
    infoBorder: "#2c4e6e",
  },
} as const;

/** Class toggled on <html> to select the dark color scheme. */
export const DARK_MODE_SELECTOR = ".cellar-dark";

export const cellarPreset = definePreset(Aura, {
  semantic: {
    primary: cellarPalette,

    focusRing: {
      width: "2px",
      style: "solid",
      color: "{primary.color}",
      offset: "2px",
      shadow: "none",
    },

    colorScheme: {
      light: {
        surface: cellarSurface,
        primary: {
          color: "{primary.700}",
          contrastColor: "#ffffff",
          hoverColor: "{primary.800}",
          activeColor: "{primary.900}",
        },
        highlight: {
          background: "{primary.100}",
          focusBackground: "{primary.200}",
          color: "{primary.900}",
          focusColor: "{primary.950}",
        },
        text: {
          color: "{surface.900}",
          hoverColor: "{surface.950}",
          mutedColor: "{surface.700}",
          hoverMutedColor: "{surface.800}",
        },
        content: {
          background: "{surface.0}",
          hoverBackground: "{surface.100}",
          borderColor: "{surface.200}",
        },
        overlay: {
          select: {
            background: "{surface.0}",
            borderColor: "{surface.200}",
            color: "{text.color}",
          },
          popover: {
            background: "{surface.0}",
            borderColor: "{surface.200}",
            color: "{text.color}",
          },
          modal: {
            background: "{surface.0}",
            borderColor: "{surface.200}",
            color: "{text.color}",
          },
        },
        formField: {
          background: "{surface.0}",
          disabledBackground: "{surface.100}",
          filledBackground: "{surface.50}",
          filledHoverBackground: "{surface.100}",
          filledFocusBackground: "{surface.0}",
          borderColor: cellarFieldBorder.light,
          hoverBorderColor: "{surface.600}",
          focusBorderColor: "{primary.color}",
          invalidBorderColor: cellarSemantic.light.error,
          color: "{surface.900}",
          disabledColor: "{surface.400}",
          placeholderColor: "{surface.600}",
          invalidPlaceholderColor: cellarSemantic.light.error,
          floatLabelColor: "{surface.600}",
          floatLabelFocusColor: "{primary.color}",
          floatLabelActiveColor: "{surface.600}",
          floatLabelInvalidColor: cellarSemantic.light.error,
          iconColor: "{surface.500}",
          shadow: "0 1px 2px 0 rgba(31, 24, 28, 0.06)",
        },
        navigation: {
          item: {
            focusBackground: "{surface.100}",
            activeBackground: "{primary.50}",
            color: "{text.color}",
            focusColor: "{text.hoverColor}",
            activeColor: "{primary.700}",
            icon: {
              color: "{surface.500}",
              focusColor: "{surface.600}",
              activeColor: "{primary.700}",
            },
          },
        },
      },

      dark: {
        surface: cellarSurface,
        primary: {
          color: "{primary.400}",
          // Near-black wine on a rose fill. White would be 2.97:1.
          contrastColor: cellarDark.onPrimary,
          hoverColor: "{primary.300}",
          activeColor: "{primary.200}",
        },
        highlight: {
          background: "rgba(196, 64, 95, 0.18)",
          focusBackground: "rgba(196, 64, 95, 0.28)",
          color: "{primary.300}",
          focusColor: "{primary.200}",
        },
        text: {
          color: cellarDark.text,
          hoverColor: "#ffffff",
          mutedColor: cellarDark.textMuted,
          hoverMutedColor: "{surface.300}",
        },
        content: {
          background: "{surface.900}",
          hoverBackground: cellarDark.elevated,
          borderColor: cellarDark.border,
        },
        overlay: {
          select: {
            background: cellarDark.elevated,
            borderColor: cellarDark.border,
            color: "{text.color}",
          },
          popover: {
            background: cellarDark.elevated,
            borderColor: cellarDark.border,
            color: "{text.color}",
          },
          modal: {
            background: "{surface.900}",
            borderColor: cellarDark.border,
            color: "{text.color}",
          },
        },
        formField: {
          background: "{surface.900}",
          disabledBackground: cellarDark.elevated,
          filledBackground: cellarDark.elevated,
          filledHoverBackground: "{surface.800}",
          filledFocusBackground: "{surface.900}",
          borderColor: cellarFieldBorder.dark,
          hoverBorderColor: "{surface.500}",
          focusBorderColor: "{primary.400}",
          invalidBorderColor: cellarSemantic.dark.error,
          color: cellarDark.text,
          disabledColor: "{surface.600}",
          placeholderColor: cellarDark.textSubtle,
          invalidPlaceholderColor: cellarSemantic.dark.error,
          floatLabelColor: cellarDark.textMuted,
          floatLabelFocusColor: "{primary.400}",
          floatLabelActiveColor: cellarDark.textMuted,
          floatLabelInvalidColor: cellarSemantic.dark.error,
          iconColor: cellarDark.textSubtle,
          shadow: "0 1px 2px 0 rgba(10, 6, 8, 0.4)",
        },
        navigation: {
          item: {
            focusBackground: cellarDark.elevated,
            activeBackground: "rgba(196, 64, 95, 0.16)",
            color: "{text.color}",
            focusColor: "{text.hoverColor}",
            activeColor: "{primary.300}",
            icon: {
              color: cellarDark.textSubtle,
              focusColor: cellarDark.textMuted,
              activeColor: "{primary.300}",
            },
          },
        },
      },
    },
  },

  components: {
    button: {
      colorScheme: {
        dark: {
          root: {
            // The filled primary button is deep wine with white text in dark
            // mode too: 4.95:1 at rest, 6.23:1 hover, 8.37:1 pressed.
            primary: {
              background: "{primary.500}",
              hoverBackground: "{primary.600}",
              activeBackground: "{primary.700}",
              borderColor: "{primary.500}",
              hoverBorderColor: "{primary.600}",
              activeBorderColor: "{primary.700}",
              color: "#ffffff",
              hoverColor: "#ffffff",
              activeColor: "#ffffff",
              focusRing: { color: "{primary.400}", shadow: "none" },
            },
          },
        },
      },
    },
  },
});
