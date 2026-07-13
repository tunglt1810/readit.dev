# Releasing the Chrome Extension

The release workflow runs when a semantic version tag is pushed:

```bash
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

`.github/workflows/release-extension.yml` builds the extension with the tag
version, enforces the exact Free manifest permission and host boundary
(`activeTab`, `contextMenus`, `offscreen`, `scripting`, `storage`, and only the
Hugging Face model host), runs tests, creates `readit.dev-VERSION.zip`, creates
a GitHub Release, uploads the package to Chrome Web Store, and submits it for
review.

The Free release does not require `api.readit.dev`, Cloudflare Workers, D1,
license secrets, analytics, or crash-reporting services. The `backend/` folder
is future-Pro source and must not be included in the extension build or ZIP.

## First Chrome Web Store release

The first item must be initialized in the Chrome Web Store Developer Dashboard.
Push `v1.0.0` first; the workflow will build the package and create the GitHub
Release, then stop at the Chrome Web Store steps until credentials exist.
Download that ZIP, upload it manually, complete Store Listing and Privacy
information, and publish it once. Then configure the GitHub secrets below.
Use `v1.0.1` for the first fully automated store release. Re-running the same
tag is safe for the GitHub Release asset.

The release package includes `THIRD_PARTY_NOTICES.txt`, which contains the
required attribution and license links for Supertonic 3 and the runtime
dependencies. The workflow validates that this file is present before it
creates the release archive.

Before submitting a Free release, verify the [Free MVP Design Specification](./specs/2026-07-12-free-mvp-design.md),
the [Privacy Policy](./privacy-policy.md), and the Chrome Web Store privacy
disclosures describe the same local-processing and no-telemetry behavior.

Create a GitHub Environment named `chrome-web-store` and add these environment
secrets:

- `CWS_PUBLISHER_ID`: Publisher ID from Developer Dashboard settings.
- `CWS_EXTENSION_ID`: Chrome Web Store item ID.
- `CWS_CLIENT_ID`: Google OAuth client ID.
- `CWS_CLIENT_SECRET`: Google OAuth client secret.
- `CWS_REFRESH_TOKEN`: OAuth refresh token with the `chromewebstore` scope.

Keep the environment protected with required reviewers because the workflow can
submit a public store release. `GITHUB_TOKEN` is provided automatically by
GitHub and needs `contents: write` to create the GitHub Release.
