# 12. Config Snapshots & Restore

![Config history](../images/snapshots.png)

ModelSwap automatically snapshots the current config **before every provider/model switch, every site save, and every manual config-file save**.

1. Go to **Settings → Config History**
2. Filter by agent (or view all); each version shows its timestamp and affected files
3. Click **View** for a side-by-side diff (added/removed line counts, JSON compared key-sorted to cut noise), then **Restore** to roll back
4. Restoring takes its own safety snapshot first, so a restore itself is reversible

Bad switch, broken config, or "last week's combo" — this is where you get it back.
