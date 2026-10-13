# Recovery checkpoint device renumbering — 2026-10-12

## Reproduced failure

After the required Mac reboot, the operator's original record retained its SHA-256 and inode (172889759), but `stat` reported device 16777224 instead of the checkpoint's 16777226. The old verifier compared the boot-local `st_dev` value to the historical value and stopped with `Captured record was replaced or altered.` The checkpoint and record were not changed by that failed preview.

## Correction

`verifyAfterReboot` still verifies the same host, changed native boot identity and exact record inventory first. On Darwin only, it then binds the current checkpoint, archive and mutation-state paths to the state directory's current device. Record bytes, inode, canonical workspace authority, ownership, permissions, regular-file/single-link status, and symlink checks remain mandatory. Non-Darwin comparison is unchanged.

This is a current-boot mount check, not a claim that `st_dev` is a persistent volume UUID. Version-1 checkpoints did not store a volume UUID, so the existing same-host, exact canonical path, inode, cryptographic content and inventory evidence is retained. The pre-reboot checkpoint is not rewritten, migrated or replaced. If an inode or contents changed, recovery still stops.

Each record's observed current device is pinned for the final check before archival. `readExactFile` continues to compare device/inode across every single read. The archive must still be on the pinned current device before rename. Device-number changes are visible in the preview and persisted audit as `deviceRebindings`.

## Regression coverage

The existing checkpoint suite now includes ten device-renumbering scenarios: preview/apply/replay success, same-boot refusal, foreign-host refusal, changed bytes, replaced inode, symlink, new record, missing confirmation, resumed partial archive, and unchanged non-Darwin refusal. Fixtures modify only their synthetic historical device field; production checkpoints are never patched to pass.

## Operator rollout

Update only the isolated recovery checkout to the tested commit, reuse the original checkpoint ID, and run preview before apply. Another reboot or fresh checkpoint is not required solely for this correction. Do not infer success from a test run: confirm the actual preview output and archival result, then check normal Rel.AI workspace admission. The installed desktop app and FlightCanvas project are not changed by the verifier update.
