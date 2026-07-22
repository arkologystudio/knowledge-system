# Obsidian leg — setup

Unlike the Drive and Notion legs, **Obsidian needs no mirror code**. An Obsidian
vault is already a folder of markdown on disk, so the right mechanism is the
**Obsidian Git community plugin**, which commits and pushes the vault on an
interval. The author keeps working exactly as before; the vault simply *is* a
working copy of the corpus.

This is the ratified design (`source-mirror-pattern.md`, Obsidian leg) and the
reason there is no `MirrorSource` of kind `obsidian` in the registry.

## One-time setup (operator, ~5 minutes, no shell)

1. **Use a dedicated organisational vault** — never a personal one. Private
   material must never be swept in; a separate vault is a cleaner boundary than
   trying to mirror a subfolder.
2. Install the **Obsidian Git** community plugin in that vault
   (Settings → Community plugins → Browse → "Obsidian Git").
3. Point the plugin at the **brain repository**, into the `sources/obsidian/`
   subtree, so the vault lands beside the other mirrored sources and never under
   `wiki/` (authored notes) or another leg's directory.
4. Set the plugin to auto-commit and push on an interval (a few hours is
   comfortable; it need not be tighter than the Drive/Notion sync cadence).

A push triggers the brain's existing reindex webhook, so an edit in Obsidian
reaches the brain within one sync interval with no manual step.

## Identity and provenance

Vault notes are **authored content**, so they are never rewritten by the mirror
(that would clobber the author's frontmatter — the exact failure the RID backfill
was fixed to avoid). Instead, identity and provenance ride the engine's shipped
machinery on the `sources/obsidian/` source:

- `gbrain rid backfill` **surgically** stamps a stable `ref_id` into each note —
  one added line, every other byte untouched (v0.43.0.5) — so vault notes get
  KOI-compatible identity without hand-editing.
- The brain's git sync indexes the notes with their own frontmatter as
  provenance.

Because the vault is authored markdown the brain already knows how to ingest,
the Obsidian leg is configuration plus this note — not software.

## What this deliberately does NOT do

- It does not build a custom sync client — the community plugin is the mechanism.
- It does not mirror a personal vault — only a dedicated organisational one.
- It does not run inside the mirror's `MirrorSource` fetch path — there is no
  API to poll; the files arrive by the plugin's push.
