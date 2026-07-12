---
layout: page
title: Privacy Policy
permalink: /privacy-policy/
---

# Privacy Policy

**Last updated: July 13, 2026**

readit.dev is a Chrome extension that turns the readable content of the current web page into audio. This policy explains what the extension accesses, what is processed locally, and what information is sent to our services.

## Summary

- Page content is processed locally on your device for text-to-speech.
- The article text is not uploaded to the readit.dev backend by the current version of the extension.
- We do not sell user data or use page content for advertising, profiling, analytics, or crash reporting.

## Information the extension accesses

When the extension is installed, its content script can be present on supported web pages so that the read action is available. If a page was already open
when the extension was activated or updated, the extension may inject that
content script into the active tab after you click **Read current page**. The
extension extracts article content only after that user action.

For that feature, the extension may temporarily access:

- the page title and readable text;
- the current page URL;
- the page language;
- the active tab needed to perform the requested reading action.

The extracted article is passed between extension components in the browser and is used by the on-device Supertonic text-to-speech engine. It is kept temporarily in extension memory while playback is running and is not sent to the readit.dev backend.

The extension may store your selected voice, playback speed, and popup UI
locale locally in Chrome. While a reading session is active, it also keeps a
session-scoped snapshot containing the page title, URL, language, tab ID,
playback status, progress, selected voice, speed, and update time. This
snapshot is stored in `chrome.storage.session` so the popup can reconnect to
playback after it is closed; it is cleared when the session stops and is not
restored after the browser restarts. The extracted article text and generated
audio are not included in this snapshot and are not stored as product data.

Do not use the extension on pages containing information that you are not permitted to process. The extension does not bypass paywalls, login restrictions, DRM, or other technical access controls.

## Third-party services

The extension may contact these services:

- **Hugging Face**, to download the Supertonic model files the first time they are needed. Page content is not included in those model requests. The model is subject to the [OpenRAIL-M license](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE);
- **GitHub Pages**, to display this privacy policy when you follow the policy link.

The extension may also open the Buy Me a Coffee website when you explicitly select that link.

## Information we do not collect

The current version does not intentionally collect or transmit article text, audio generated from article text, browsing history, passwords, form submissions, email addresses, license keys, device identifiers, advertising profiles, analytics events, or crash reports.

## Security and retention

Article text is processed locally and is not retained by a readit.dev backend. The model files are cached locally by the browser after download.

You can remove locally cached extension data by uninstalling the extension or clearing its storage in Chrome.

## Changes to this policy

We may update this policy when the extension's data practices change or when required by law. The updated version will be published at this URL with a new “Last updated” date.

## Contact

For privacy questions, use the [readit.dev GitHub repository](https://github.com/tunglt1810/readit.dev/issues). Please avoid including private data in public issues.
