# Shared folders (spaces)

A shared folder is a **space** with its own storage, key and history, using the vault's sync engine. This slice owns records, the partition, access, invites, moves, pause and the share window; its only networking is the broker client. Constraints: `.claude/rules/spaces.md`, `.claude/rules/sync-integrity.md` (Spaces), `.claude/rules/realtime.md`, `.claude/rules/security.md`.

## Map

- `records.ts`, `record.ts`, `remote.ts`: records and their trade; `partition.ts`: scope and pause.
- `owner.ts`, `access.ts`: owner storage and share keys; `broker/`: client and lazy signing; `packages/relay/src/share/`: broker server.
- `share-moves.ts`: following root moves; `ui/share-action.ts`, `ui/invites/invite-action.ts`: lifecycle entry points; `ui/window/share-window.ts`: share window.

## Decisions

| Decision | Why |
|---|---|
| One engine for vault and shares | One history, one live path, no parallel share cycle |
| One space per path; shared data lives once | Two writers on one path corrupt it |
| No accounts; the vault's bucket is the person's control plane | Serverless, no third-party service |
| No integration with No-Instructions/Relay | Paid past 3 participants, closed control plane; MIT code may be borrowed with source-header attribution, as in `packages/plugin/src/features/sync/hunks/anchored-hunks.ts`; no NOTICE file |

## Model

A person's devices share their vault; other people join by invite.

| | root | key | storage | hub grant |
|---|---|---|---|---|
| vault | `/` minus share roots | vault data key | bucket root | `deriveChannelGrant(RELAY_SECRET, channel)` |
| own share | a folder | share key | `<prefix>/shares/<id>/` | same |
| joined share | own folder | share key | broker, presigned URLs | share token |

New shares inherit the owner's name from existing shares, falling back to "Owner"; peers read it from the owner's announcement (`ChannelPresence.nameOf`).

Record-read caches are per storage, key and prefix; just-published and undecodable records are read again next cycle. Without listing etags every record is read.

Lazy signing avoids per-object requests that made pulls several times slower than direct S3: one token check and signing-key derivation per batch. Existence probes remain listings.

## Lifecycle

- **Share folder**: `shareFolder` starts publication and push; its signal wakes the owner's other devices to mount. Without a relay, sharing still works across those devices, but inviting does not.
- **Re-invite / relay move**: renew access through a new link, keeping folder and baseline; the owner's share window names the old relay.
- **Guest becoming a vault device**: the first records trade reconciles the guest's joins with the vault; an owned share's folder moves to the owner's root.
- **Move**: paths inside the share and docIds stay unchanged. A root gone on one device detaches that device (`SpaceGoneError`); it never deletes for all.
- **Stop / Leave**: failed remote cleanup leaves orphans. Leave revokes only its own token, never a later-issued one.
- **Revocation**: once confirmed by the broker, close without another broker call and ask whether to keep files or trash the folder. Hub `REVOKED` triggers a pull to ask the broker soon. People may lag an invite; revokes appear at once because the list reads each pointer.

## Accepted limitations

- Unnamed owners of different shares look alike (`owner`).
- The editor lock leaves Properties, renames and other plugins writable; edits wait unpushed. Open notes moved into read-only roots lock on reopening; drawings lock after loading (up to 500 ms), but scripts can edit them.
- Read-only changes stay pending: auto-push skips them, explicit pushes containing them fail, **Revert this file** drops them. Read-only ignore changes are device-local.
- Revoked writers retain storage access for up to ~3 minutes: signing uses the KV grant (cached ~60 s), not the hub's revoked table, and a presigned URL lives 120 s. Checking the hub per signature costs a Durable Object round trip per object; these rights were valid moments before.
- Writers can DELETE objects through the broker; history, not revocation, repairs damage.
- One case-insensitive invite name is one participant; renaming creates another, unnamed invites are always new.
- Vault reset does not end dependent shares or forget live share links.
- Mounting over one's own copy converges identical files; pre-record edits conflict without a share base.
- Frozen vault blobs remain in history until it rolls off. A refresh just before creation, or one missing the whole open period and arriving after Stop sharing but before the owner's vault push, sees unchanged files as deleted; the share or owner's push restores them. Editing then closing a paused share gives that device conflicts, not a clean pull.
- Closing a missing folder returns an empty root: entries still listed by the vault read as deletions, edited files as conflicts. A share empties only by closing; deleting every file also hits `SpaceGoneError`.
- Root moves rehash once, drop any frozen old-path copy on the next vault push (history keeps it), and converge offline moves by LWW; the loser moves again. Moves outside Obsidian or while closed leave a vanished root (`SpaceGoneError`) plus new vault content.
- Switching vault storage leaves folders as plain files, warns and forgets share state. Switching back mounts afresh; folders moved meanwhile stay as vault content. New credentials for the same bucket keep owned shares.
- Failed shares retry every refresh (one broker request), without backoff. Explicit operations show their error; the scheduler does not count it.
- A closed share's ignore note becomes a plain file under the vault's rules.
- New owned shares restart the vault socket; live sessions resubscribe. The old vault room is never trimmed: other devices type there until the record signal moves them, then fold those edits into the share room.
- Acceptance signals reach a participant's other devices only with their own relay.
- Guests have no vault socket: vault/ribbon relay status says offline despite live share channels. Shares reach their other devices only after vault setup; files there never pushed join the share as with any arriving record.
- Manifest caches (`validators`, `publishedHeads`) last as long as the adapter. The root is in `ShareStorage.memo`, so moving creates a new adapter.
- Older relays refuse one signing batch per transfer before single-signing fallback.

## Tests

`packages/plugin/tests/features/spaces/`, helper `packages/plugin/tests/helpers/space-records.ts`; broker: `packages/relay/tests/share/`; flows: `pnpm e2e:shares`, `pnpm e2e:invite`, `pnpm e2e:guest`.
