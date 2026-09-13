# Local fonts

These WOFF2 files preserve the font assets from successful production candidate 21.
They replace build-time Google Fonts downloads, which failed with TLS connection
resets during candidate 22. Font faces, weights, unicode ranges, fallback metrics,
class cascade and the three Latin preloads are preserved. No font subsetting or
binary modification was performed.

`provenance.json` records every filename, byte length and SHA-256 digest.
Run `node scripts/verify-local-fonts.mjs` from `apps/web` to verify the checked-in
assets. If the original build remains available, this also compares its CSS.
`scripts/vendor-review-fonts.mjs` is an import utility, not a build dependency.

Upstream license sources (downloaded 2026-09-06):

- Noto Sans SC: https://raw.githubusercontent.com/google/fonts/main/ofl/notosanssc/OFL.txt
- Noto Serif SC: https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/OFL.txt
- Roboto: https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt

The corresponding OFL files are included in this directory and must accompany
redistribution. The hashed asset URLs must change if their contents change.
