# mac-disk-cleanup

Automated disk cleanup for macOS that will not delete anything until it has passed
three separate checks, and can be undone right up until the last one.

Written for a Mac mini M1 with a 245GB internal drive, but nothing in it is
model-specific.

---

## The one thing to understand first

**Moving files does not free space. Deleting them does.**

This tool deliberately splits those two actions apart:

| Command | What it does | Reversible? | Frees space? |
|---|---|---|---|
| `scan` | Looks. Writes a plan file. | n/a | no |
| `apply` | Moves approved items to a quarantine folder | **yes** — `restore` | no |
| `purge` | Permanently deletes the quarantine | **no** | **yes** |

So after `apply` your disk is no emptier than before. That is intentional. You get
to use your Mac for a day, confirm nothing broke, and only then run `purge`. If
something did break, `restore` puts every file back exactly where it came from.

---

## Setup (once)

**1. Get the script onto your Mac.** In Terminal:

```bash
cd ~/Downloads
git clone https://github.com/kday456/acquireadtech-rss.git
cd acquireadtech-rss/tools/mac-disk-cleanup
chmod +x mac-disk-cleanup.sh
```

**2. Tell it what to never touch.** This is the most important step. Open the file:

```bash
open -e mac-disk-cleanup.sh
```

Near the top you'll see `PROTECT_PATHS`. Add a line for every project folder,
render scratch folder, and anything else that matters — one per line, in quotes:

```bash
PROTECT_PATHS=(
  "$HOME/Documents"
  "$HOME/Movies"
  "$HOME/Pictures"
  "$HOME/Music"
  "$HOME/Desktop"
  "$HOME/Work/ClientRenders"        # <- your folders here
  "$HOME/Dropbox/Projects"
)
```

Anything listed here is rejected outright, and so is anything inside it. Save and
close.

---

## Everyday use

### Step 1 — look

```bash
./mac-disk-cleanup.sh scan
```

Read-only. Takes a minute or two. It prints:

- real free space (Finder inflates this by counting "purgeable" space as free)
- Time Machine local snapshots, which on a full drive are often the single
  biggest hidden consumer
- every candidate found, sorted biggest first, tagged **safe** or **review**
- everything the safety guards refused to consider, and why

It writes a plan file to `~/.mac-disk-cleanup-plans/` and stops. Nothing is
touched.

**safe** means rebuildable — caches, Xcode DerivedData, Trash. Losing it costs you
a slow first launch, nothing more.
**review** means *not* rebuildable — old iPhone backups, Xcode archives, files in
Downloads. These are listed for your information but `apply` will never act on
them. See the SSD section below.

### Step 2 — quarantine

```bash
./mac-disk-cleanup.sh apply --plan ~/.mac-disk-cleanup-plans/plan-YYYYMMDD-HHMMSS.tsv
```

Copy the exact plan path from the end of the scan output. Add `--dry-run` first if
you want to see the re-validation without any prompts.

This re-checks every path against the live disk (things change between scan and
apply), then asks you to **type each category name** to include it, then asks you
to **type the exact total** — e.g. `MOVE 12.4 GB`. Anything else cancels.

Files move to `~/.mac-disk-cleanup-quarantine/`. Space is not freed yet.

### Step 3 — live with it, then commit

Use your Mac normally for a day. Then either:

```bash
./mac-disk-cleanup.sh restore     # something broke — put it all back
./mac-disk-cleanup.sh purge       # all good — free the space for real
```

`purge` requires typing `DELETE <size> GB PERMANENTLY` and is the only command in
the tool that destroys data.

---

## Time Machine snapshots

Handled separately, because deleting a snapshot cannot be undone or quarantined.

```bash
./mac-disk-cleanup.sh snapshots                 # just show me
./mac-disk-cleanup.sh snapshots --reclaim 20    # ask macOS to free 20GB (recommended)
./mac-disk-cleanup.sh snapshots --delete-all    # remove every snapshot (two confirmations)
```

`--reclaim` is the gentle option: it asks macOS to free a target amount and lets
it pick the oldest snapshots itself. Prefer it.

Snapshots are on-disk copies of changed files that macOS keeps while your Time
Machine drive is disconnected. If you deleted a file recently and have no other
backup, a snapshot may be the only copy — that is why this is a separate,
irreversible command.

---

## When your 1TB external SSD arrives

The SSD does **not** help with most of what this tool finds. Caches, DerivedData,
and snapshots have to live on the internal drive; you delete those, you don't
relocate them. The SSD is for the **review** tier — the things worth keeping but
not worth 60GB of a 245GB boot drive.

Once it's mounted:

```bash
./mac-disk-cleanup.sh scan
./mac-disk-cleanup.sh archive --plan <plan file> --to /Volumes/YourSSDName
```

This copies review-tier items to the SSD with `rsync`, then verifies the copy is
byte-identical, and **leaves the originals in place**. Removing the originals is
deliberately still your call, through Finder, after you've confirmed the archive
opens correctly.

Two things worth doing when it arrives:

1. **A copy on one external drive is not a backup.** Old iPhone backups and
   finished project media on a single SSD are one drive failure from gone. Treat
   the SSD as an archive tier, not as your safety net.
2. **Consider making it your Time Machine destination.** With a backup drive
   permanently attached, macOS thins local snapshots much more aggressively, which
   largely stops the biggest space problem from recurring.

---

## What stops it from deleting the wrong thing

Every candidate passes all eight of these — at scan time, and *again* immediately
before it is moved:

1. Never acts on a top-level directory itself (`/`, `~`, `~/Library`, `~/Documents`, …)
2. Must sit under the allowlisted prefix for its category — a mangled variable
   can't redirect the deleter somewhere else
3. Must be inside your home folder
4. Must not be inside, or contain, anything in `PROTECT_PATHS`
5. Must be at least three directory levels deep
6. Must not have been modified in the last 60 minutes (a running app touches its
   own cache constantly — this is the main "is it in use?" test)
7. Must not belong to a creative app that is currently running
8. No running process may hold a file open in it

Plus: if Final Cut, Resolve, Premiere, After Effects, Compressor, ffmpeg, HandBrake
or similar is running, `apply` refuses to do anything at all unless you explicitly
pass `--allow-during-render`.

Plus: confirmations are read from the terminal directly, so you cannot pipe answers
in or accidentally auto-approve from a script.

### Known limits — worth knowing

- Guard 6 is a heuristic. An app that keeps a large cache but writes to it rarely
  could have that cache quarantined while running. This is exactly why `apply`
  only quarantines, and why `restore` exists.
- Guard 8 checks the candidate path itself, not every file beneath it recursively —
  a full recursive `lsof` on a multi-gigabyte tree takes minutes. Guards 6 and 7
  cover the realistic cases.
- The tool only ever touches your home folder. It never uses `sudo` and never
  looks at `/Library` or `/System`. System-level caches are left alone by design.

### Tunables

At the top of the script:

| Setting | Default | Meaning |
|---|---|---|
| `MIN_AGE_MINUTES` | 60 | ignore anything modified more recently |
| `DOWNLOADS_AGE_DAYS` | 30 | how old a download must be to be listed |
| `MIN_CANDIDATE_MB` | 50 | ignore candidates smaller than this |
| `SIZE_TOLERANCE_PCT` | 25 | how much a path may change between scan and apply |
