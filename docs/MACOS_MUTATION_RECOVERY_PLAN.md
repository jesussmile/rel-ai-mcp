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

## Implemented operator commands (repair branch)

The draft implementation adds a **local terminal CLI**, not a remotely callable MCP
unlock operation. It uses Rel.AI's configured workspace authority and private local
state. No callers can supply host/boot evidence through command-line flags.

```bash
node bin/relai-mcp-config.js mutation-recovery inspect flightcanvasglobe
node bin/relai-mcp-config.js mutation-recovery prepare flightcanvasglobe
# Record the checkpointId from the result. Safely close apps and fully reboot macOS.
node bin/relai-mcp-config.js mutation-recovery preview flightcanvasglobe <checkpointId>
node bin/relai-mcp-config.js mutation-recovery apply flightcanvasglobe <checkpointId> --confirm
```

`inspect` reports a read-only inventory. `prepare` durably checkpoints the precise
v3 ownership record identities and OS host/boot hashes, but does **not** alter locks.
After a full reboot, `preview` rejects a mismatched host, unchanged boot identity,
changed or unbound recovery records, new records, invalid paths and incomplete
inventories. `apply` additionally requires `--confirm`, durably records a recovery
attempt, and **archives** the verified original bytes without discarding them.
A partial archive can be inspected or finished after an interrupted CLI call.
No process is killed and no interrupted task is marked completed.

The archive is stored in the Rel.AI local state directory under
`mutation-recovery-checkpoints/<checkpointId>/records`. Never manually delete
recovery files to make the dashboard turn green. If additional workspace mutation
locks remain, they still require independent reconciliation.

## Validation and deployment status

- Dedicated Node 26 macOS CI verified syntax, the recovery regression suite,
  CLI help integration, and access to native machine/boot identity.
- Full repository CI is tracked separately; a green focused workflow does not
  mean every existing repository test or desktop package passed.
- The repair currently lives **only in the fork's draft branch**. The installed
  Rel.AI Mac application has **not** been modified, repaired or restarted by
  these GitHub changes.
- Installing or running the operator CLI on the real user's state must wait for
  full review and macOS packaging. The existing FlightCanvasGlobe changes and
  interrupted Unity ownership record remain untouched.
