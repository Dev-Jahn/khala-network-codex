# Vendored dependencies

- `khala/khala`: unchanged MIT-licensed upstream brain. Version, Git commit,
  SHA-256 and platform release digests are in `khala/upstream.json`. The root
  `LICENSE` retains upstream attribution. Update with `scripts/vendor-khala.mjs`.
- `ws/`: unmodified npm tarball `ws@8.21.3`, MIT (`ws/LICENSE`). npm integrity:
  `sha512-201TZ/kPWxoPr/OKWjquZR1SWKXcvxdH+e1xrx89b3YbmzLMFCLfnaG1HFIgWzJOEWZ7MvpK++odZufgYR50Rw==`.
  Per-file SHA-256 checksums are in `ws.sha256.json` and checked by CI.

`ws` is included so an installed plugin can connect to Codex's WebSocket-over-
Unix transport without running npm at session start. Native optional addons
are not installed or required.
