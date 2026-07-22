# Source Mirror — setup for a non-technical operator

This guide connects your organisation's existing knowledge — **Google Drive,
Notion, and an Obsidian vault** — to your brain, so everything you already have
becomes searchable through the Knowledge System. It is written for someone who
has **never used a terminal**. Every step happens in a browser or an app.

The whole thing runs on a schedule by itself once set up. Setup takes about
**30 minutes** the first time.

## How it works, in one picture

The Source Mirror copies your Drive/Notion/Obsidian content into a **git
repository of markdown** (your "brain repo"), and the brain reads from that repo.
Nothing runs on your own computer or server — the copying happens on GitHub's
free scheduled runners. The result is a corpus you own outright and can walk away
with, in plain markdown, forever.

Two rules make it safe:

- The mirror only ever writes into a `sources/` folder. It can never touch or
  delete notes you or your agents authored.
- If a source ever returns a suspiciously empty result (usually a login that
  quietly expired), the run **stops instead of deleting everything** and tells
  you.

## What you'll need to create (the credential checklist)

You create each of these yourself — **the assistant never creates, types, or
stores a credential for you.** Have them ready; the steps below produce each one.

| # | Credential | For | Where it goes |
|---|---|---|---|
| 1 | A **private git repo** (your "brain repo") | holds the mirrored markdown | GitHub |
| 2 | A **Notion internal-integration token** | the Notion source | a GitHub secret `NOTION_TOKEN` |
| 3 | An **rclone config** for Google Drive | the Drive source | a GitHub secret `RCLONE_CONF` |
| 4 | A **read token** for the mirror code repo | fetching the mirror | a GitHub secret `KS_REPO_TOKEN` |
| 5 | A **write token** for your brain repo | pushing mirrored files | a GitHub secret `BRAIN_REPO_TOKEN` |

Keep these private. Paste each one **only** into the GitHub "Secrets" screen shown
below — never into a document, chat, or file.

## Step 1 — Make your brain repo

1. On GitHub, create a new **private** repository (for example `your-org-brain`).
2. That's it for now. The mirror will fill it in.

## Step 2 — Connect Google Drive

1. Install **rclone** (rclone.org) — a free download; on most machines it is a
   single installer.
2. Run its setup wizard (`rclone config` opens a guided, numbered menu). Choose
   **Google Drive**; it opens your browser to sign in and grant read access, and
   stores the result for you.
3. When it finishes, it has written a small config file. You will paste the
   **contents** of that file into GitHub secret **`RCLONE_CONF`** in Step 5.
4. Decide **which folders** to mirror. A curated set beats "everything" — noise in
   the corpus crowds out signal. You'll name the folder in the config in Step 5.

Google Docs arrive as readable markdown. PDFs and Word documents have their text
extracted and linked back to the original in Drive — the original file itself is
never copied into the repo.

## Step 3 — Connect Notion

1. Go to **notion.so/my-integrations** and create a **new internal integration**.
   Give it read access. Copy the **Internal Integration Token** it shows you —
   this is secret **`NOTION_TOKEN`** for Step 5.
2. In Notion, open each page (or top-level page) you want mirrored, click
   **`•••` → Connections → your integration**. Only pages you share this way are
   ever mirrored — nothing else is visible to the integration. This is your
   privacy control: share exactly what you want in the brain.

## Step 4 — Connect Obsidian (optional)

If you keep notes in Obsidian, use a **dedicated organisational vault** (not your
personal one) and follow **[`templates/mirror/obsidian-setup.md`](../../templates/mirror/obsidian-setup.md)**
— it's a 5-minute, in-app plugin setup. Obsidian needs no tokens.

## Step 5 — Turn on the scheduled mirror

1. Copy the file **[`templates/mirror/mirror.yml`](../../templates/mirror/mirror.yml)**
   into your brain repo at `.github/workflows/mirror.yml` (GitHub lets you add a
   file straight in the browser: **Add file → Create new file**).
2. Copy **[`templates/mirror/mirror.config.example.json`](../../templates/mirror/mirror.config.example.json)**
   into your brain repo as `mirror.config.json`, and edit the Drive `folder` to the
   folder you chose in Step 2.
3. In your brain repo, open **Settings → Secrets and variables → Actions**, and add
   the four secrets from the checklist: `NOTION_TOKEN`, `RCLONE_CONF`,
   `KS_REPO_TOKEN`, `BRAIN_REPO_TOKEN`. (Tokens 4 and 5 are GitHub
   "personal access tokens" — GitHub's own **Settings → Developer settings** walks
   you through creating each; give #4 read access to the mirror code repo and #5
   write access to your brain repo.)

The mirror now runs **every four hours** automatically. To change how often, edit
the `cron` line at the top of `mirror.yml` (the file explains the format). You can
also run it any time from your brain repo's **Actions** tab → **source-mirror** →
**Run workflow** — including a **dry run** that shows what *would* change without
changing anything.

## Step 6 — Point the brain at the repo

Once the first run has populated your brain repo, connect it to the brain so it
gets indexed and stays in sync:

```
gbrain sources add org-mirror --url https://github.com/your-org/your-org-brain.git
```

(Whoever operates the brain runs this once; a push from the mirror then updates the
brain automatically through its existing sync.)

## Checking it worked

- In your brain repo's **Actions** tab, the **source-mirror** run shows green.
- The repo now has a `sources/` folder with `drive/`, `notion/`, and (if used)
  `obsidian/` sub-folders full of markdown.
- Search your brain for something you know is in Drive or Notion — it's there.

If a run ever fails, GitHub emails you and the **Actions** tab shows which source
failed; the other sources still updated. Fix the credential it names and re-run.

## Good to know

- **Nothing destructive happens silently.** A run that would remove an unusually
  large share of a source refuses and reports why.
- **You own the corpus.** It's plain markdown in your git repo — portable and
  durable, independent of any software.
- **Renaming is safe.** Rename a Google Doc or Notion page and the mirror moves it
  rather than losing the links into it.

## The human-only checklist (never delegate these)

Creating and pasting the five credentials above is **always your step** — an
assistant or agent must never mint, paste, or commit a live token on your behalf.
Everything else (the mirror code, the schedule, the safety rails) is automated.
