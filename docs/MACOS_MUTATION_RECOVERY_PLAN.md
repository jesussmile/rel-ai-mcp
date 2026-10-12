# macOS mutation-recovery repair plan

## Incident

On 2026-10-12 the `flightcanvasglobe` workspace was blocked by `WORKSPACE_MUTATION_TERMINATION_UNCERTAIN` for a Unity EditMode test launched under PID 47051. The test report recorded 250 passing tests, but the process-tree termination receipt was interrupted. A macOS `ps` inspection later found no process matching the original PID, its parent or process group, or the expected Unity/build executable names. **This observation does not establish that all detached descendants exited.**

The current recovery inventory in `src/mutationProcessOwnership.js` is intentionally fail-closed. A root-PID disappearance, restarting Rel.AI, or clearing the record without a process-tree proof must **not** unlock writes.

## Proposed supported recovery feature

1. Provide an authenticated, workspace-scoped **preview** operation that lists bounded, authority-verified uncertain ownership records and explains why writes remain blocked. Never expose raw host identity or unrelated workspaces.
2. Add an explicit **prepare recovery** operation which durably snapshots exact record hashes and file identities together with a trusted host/OS-boot identity. No records are removed during preparation.
3. Only after a **full OS reboot on the same host**, allow a second authenticated operation to verify that the host identity matches, the boot identity changed, and the complete current record inventory is byte-for-byte unchanged. A Rel.AI app restart, PID absence, elapsed time, or user-supplied assertion must not qualify.
4. Archive only the exact records included in the verified snapshot, retaining an audit trail. Reject symlinks, mismatched authority, new/missing records, ambiguous legacy records, unreadable files, and concurrent mutation. Preserve all other workspace/task locks.
5. Provide a dry-run result and require explicit operator confirmation for archival. The recovery operation must not mark the interrupted task successful, kill processes, modify Git, or launch a pending build.
6. After recovery, recheck the workspace's mutation-block projection and resume the original Xcode/iPad deployment only if it reports ready.

## Regression coverage required

- Same-boot attempt rejected, even with an empty `ps` result.
- Reboot with a different host identity rejected.
- Reboot on the same host with unchanged, complete record inventory permits exact-record archival.
- Modified/new/missing/symlinked/unbound records rejected; other workspace records untouched.
- Crash during archival is recoverable without deleting unverified records.
- Concurrent writes cannot race the final verification/archival.
- Mac-native host/boot probes and packaging verified; Linux and Windows behavior unchanged.

## Current implementation status

This document is a design and regression checklist, **not an integrated or validated patch**. No recovery lock has been cleared. The existing installed application and FlightCanvasGlobe project are unchanged. Do not deploy a recovery build until its CLI/API integration, focused tests, Mac packaging, and operator review are complete.
