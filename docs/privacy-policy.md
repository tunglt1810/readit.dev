---
layout: page
title: Privacy Policy
permalink: /privacy-policy/
---

# Privacy Policy

**Last updated: September 6, 2026**

readit.dev is a Chrome extension that turns the readable content of the current web page into audio. This policy explains what the extension accesses, what is processed on your device, what is sent to Microsoft's speech service, and what is sent to our services.

## Summary

- The extension offers two voice engines. **Online voices** are the default and send the text being read to Microsoft's speech service to be
  synthesized. **On-device voices** run entirely in your browser and send nothing.
- You can switch to on-device voices at any time in Settings, under **Voice engine**. That choice is remembered.
- Article and pasted text are not uploaded to the readit.dev backend, telemetry, or crash-reporting services by the current version of the
  extension.
- We do not sell user data or use page or pasted content for advertising, profiling, analytics, or crash reporting.

## Information the extension accesses

When the extension is installed, its content script can be present on supported web pages so that the read action is available. If a page was already open
when the extension was activated or updated, the extension may inject that
content script into the active tab after you click **Read current page**. The
extension extracts article content only after that user action.

You may also explicitly paste or type text into the Side Panel and ask the extension to read it. That text is passed between extension contexts
in the browser and is not persisted. With online voices selected, it is also sent to Microsoft to be synthesized, exactly as article text is.

For that feature, the extension may temporarily access:

- the page title and readable text;
- the current page URL;
- the page language;
- the active tab needed to perform the requested reading action;
- text you explicitly submit through the Side Panel.

The extracted article or submitted pasted text is passed between extension components in the browser and is used by the on-device Supertonic
text-to-speech engine. It is kept temporarily in extension memory while playback is running and is not sent to the readit.dev backend,
telemetry, or crash reporting.

The extension may store your selected voice, playback speed, and popup UI
locale locally in Chrome. While a reading session is active, it also keeps a
session-scoped snapshot containing the page title, URL, language, tab ID,
playback status, progress, selected voice, speed, and update time. This
snapshot is stored in `chrome.storage.session` so the popup can reconnect to
playback after it is closed; it is cleared when the session stops and is not
restored after the browser restarts. The extracted article text and generated
audio are not included in this snapshot and are not stored as product data.

For manual playback, the session snapshot contains only playback metadata,
including the resolved language, playback status and progress, selected voice,
speed, update time, and a random Side Panel owner ID. It contains no page URL,
tab ID, text-derived title, or pasted content. The pasted-text draft remains
only in the active Side Panel document. Closing or reloading that Side Panel
stops owned audio and discards the draft and any manual checkpoint.

Do not use the extension on pages containing information that you are not permitted to process. The extension does not bypass paywalls, login restrictions, DRM, or other technical access controls.

## Third-party services

The extension may contact these services:

- **Microsoft**, when online voices are selected, to synthesize speech. The extension sends the text being read, one passage at a time, together
  with the chosen voice and reading speed, and receives audio back. No account, sign-in, or identifier of yours accompanies those requests, and
  we neither operate nor control that service; Microsoft's handling of the data is governed by its own terms. Selecting on-device voices in
  Settings stops these requests entirely;
- **Hugging Face**, to download the Supertonic model files the first time they are needed. Article and pasted content are not included in those
  model requests. The model is subject to the [OpenRAIL-M license](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE);
- **GitHub Pages**, to display this privacy policy when you follow the policy link.

The extension may also open the Buy Me a Coffee website when you explicitly select that link.

## Information we do not collect

Beyond the speech synthesis described above, the current version does not intentionally collect or transmit article text, pasted text, audio
generated from that text, browsing history,
passwords, form submissions, email addresses, license keys, device identifiers, advertising profiles, analytics events, or crash reports.

## Security and retention

Article and pasted text are not retained by a readit.dev backend. Pasted-text drafts are discarded when their Side
Panel document closes or reloads. During a same-document web-reading
preemption, a decoded manual-audio checkpoint may exist only in live extension
memory until it is resumed, discarded, or the Side Panel closes or reloads.
The model files are cached locally by the browser after download.

You can remove locally cached extension data by uninstalling the extension or clearing its storage in Chrome.

## Changes to this policy

We may update this policy when the extension's data practices change or when required by law. The updated version will be published at this URL with a new “Last updated” date.

## Contact

For privacy questions, use the [readit.dev GitHub repository](https://github.com/tunglt1810/readit.dev/issues). Please avoid including private data in public issues.
