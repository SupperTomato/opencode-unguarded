# Third-party notices

## OpenCode

This distribution is derived from OpenCode:

- Repository: https://github.com/anomalyco/opencode
- Version: 2.1.2
- Tag: v2.1.2
- Commit: a517687fde98a7329ada3ae644a01a9fc6c4e99e
- License: MIT (see `LICENSE`)

The MIT license text in `LICENSE` is the upstream OpenCode license and applies to the
source and binaries distributed here, including the modified prompt templates and
telemetry changes.

## evil-opencode

The approach of modifying built-in model prompts and removing telemetry at build time
is based on https://github.com/winmin/evil-opencode (MIT).

The implementation in `script/unguarded/` is an independent reimplementation written
against the v2.1.2 source layout. It does not copy upstream build workflows.
