# Popup and Side Panel Support Header and Theme Settings Design

**Status:** Approved design; implementation pending  
**Date:** July 22, 2026  
**Scope:** Popup and Side Panel presentation only

## Summary

Move the existing Buy me a coffee link from the popup footer to the popup
header. Relocate the existing theme selector into Settings without changing its
stored preference or keyboard interaction. Give the Side Panel the same header
information order: product name, installed version, then Buy me a coffee.

## Product decisions

### Popup header and footer

The popup header displays, left to right:

1. `readit.dev` product identity;
2. `v<manifest version>`; and
3. the localized Buy me a coffee link, including its coffee icon.

The version remains sourced from `chrome.runtime.getManifest().version`. The
Coffee link continues to use the existing constant URL and opens in a new tab
with `rel="noreferrer"`.

Coffee is removed from the popup footer, so it has exactly one popup
appearance. The footer retains Feedback and Privacy Policy. The Feedback URL
continues to include only the extension version and no page-derived data.

### Theme in Settings

Theme selection becomes the final always-visible popup Settings row, after the
selected-text button and word-highlight toggles. It retains the existing
explicit dropdown behavior: click or Enter toggles it, Escape and loss of focus
close it, and selecting a theme persists the existing theme preference.

The Theme row uses the same border, padding, and horizontal alignment as the
two toggle rows, with its localized label on the left and a text button on the
right. That button always shows the active theme's localized name without an
icon (for example, `Hiện đại`, `Classic (1998)`, or `Vista Aero (2006)`) and
opens the existing menu. The menu retains its existing labeled choices,
including their decorative icons. The row is a non-label container so the
nested button remains valid interactive HTML.

The selector must not be conditional on the active theme. In particular, it
remains visible while WMP12 is active, even though WMP12 continues to present
its Voice Style and speed controls in its existing transport layout. The
dropdown remains opaque for legibility.

### Side Panel header

The Side Panel keeps its independent content layout but its header adopts the
popup's support presentation: product identity, manifest version, then the
localized Coffee link. The three items are baseline-aligned, retain the
existing theme tokens, and use the popup header's visual separator treatment.

The Side Panel gets no duplicate Coffee link elsewhere and does not gain a
separate theme control or preference.

## Accessibility and failure behavior

The Coffee links have their localized visible names, are keyboard reachable,
and open only from an explicit user activation. Moving controls does not add a
network request, change playback, or alter stored voice, speed, or theme data.

## Acceptance checks

- Popup header order is product identity, version, and Coffee; Coffee is absent
  from the popup footer.
- The popup Theme selector is absent from the header, follows the
  word-highlight toggle in Settings, and retains click, keyboard, focus-loss,
  persistence, and opaque-dropdown behavior in Default, Winamp, and WMP12
  themes.
- No standalone Theme card remains; the final Theme row visually matches the
  two preceding toggle rows and shows the active theme name instead of the
  palette icon.
- Side Panel header contains the localized Coffee link after the identity and
  version, with the existing URL, `target="_blank"`, and `rel="noreferrer"`.
- Popup and Side Panel remain readable and focusable in all three stored
  themes; playback and privacy behavior are unchanged.

## Non-goals

- Changing theme definitions, theme persistence, or Side Panel content order.
- Removing the decorative icons from the theme choices inside the open menu.
- Adding a new preference, dependency, telemetry, or support destination.
- Changing Feedback or Privacy Policy behavior.
