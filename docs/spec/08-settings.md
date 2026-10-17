# 08 · Settings and host

Settings is a page on desktop (section list beside titled cards) and a sheet
over the current page on a phone (sections as a sideways tab strip). Sections
are addressable (`#settings/<section>`); things that take one click also run
from the palette's Settings branch (`web/settingsMenu.ts`).

## SET-1 · Security — shipped

- **This device**: its name (used for Handoff, drafts, presence), Rename,
  Lock now.
- **Add a device**: create a one-time setup code (10 minutes, once).
- **Passkeys**: list, remove.
- **Signed-in devices**: list with last use, revoke one (closes its
  terminals), sign out every other device.
- **Hosts that can reach this one**: machine tokens, revoke.
- **Master password**: whether one is set (set it on the host only).
- **Prompt history**: Clear prompt history.
- **Recent activity**: the audit log, readable.
- With sign-in off, says so first and hides what doesn't apply.

## SET-2 · Appearance — shipped

Theme, this device: System, Dark, Light, **Omarchy** (wear the host's current
Omarchy theme and monospace font on every device, terminal included, and
follow it when the desktop switches themes).

## SET-3 · Shortcuts — shipped

The shortcut table (KEY-8).

## SET-4 · Notifications — shipped

This device: enable Web Push, then choose **Needs you** and **Finished**;
what's needed when it can't (HTTPS, the home-screen app on iOS).

## SET-5 · Agents — shipped

Every agent this host knows: mark, name, command, installed version and what
changed with it, an **in New session** switch, **Check for updates**;
**Add an agent** (a dropdown of known CLIs on PATH, or any command); remove
added ones.

## SET-6 · Subscriptions — shipped

Chat subscriptions (bring your own key): named OpenAI-compatible endpoints for
side chat and Send to's summaries. Keys live on the host, masked; blank on edit
keeps the stored one; a default; hand the key to sessions as an environment
variable. A new one starts from a provider — Claude, OpenAI, Gemini, Muse —
that fills in its endpoint, name and a model and links to where keys are made;
**Other** takes any OpenAI-compatible URL. Once a key is in, Model lists the
endpoint's chat models to pick from (a saved key is only sent to its own URL);
one can still be typed by hand.

## SET-7 · Environment — shipped

Variables every session starts with: name, value (secrets write-only and
masked), remove. **Running sessions** on older values, each with Restart, and
"Restart N idle sessions".

## SET-8 · Search — shipped

Content search on or off (off drops the index), what is indexed, index status,
Rebuild.

## SET-9 · System — shipped

- **This device**: Reload page.
- **Agent hooks**: per agent, how many events are wired and where; Install /
  Remove hooks; the screen-rule audit (caught / missed per agent with the
  last missed screen; Clear).
- **Desktop app**: whether ah is in the app launcher; Add / Remove; the
  Hyprland bind to copy.
- **Server**: Restart; Rebuild and restart (deletes dist, builds from this
  checkout, restarts). Sessions keep running.
- **Uploads**: size of the uploads folder; Clear.

→ A-18: "This device" is a card in both Security and System, holding
different things.
