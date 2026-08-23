# 6. Key Sync

## 6.1 Cloud sync

End-to-end encrypted cross-machine sync. The cloud only ever sees ciphertext; the master key stays on your machine. All machines use the **same sync password**. Supported platforms: iCloud, WebDAV, Cloudflare (R2 / KV / D1 / Workers Secrets), Supabase, Volcengine.

Configure a platform and the sync password under **Settings → Cloud Backup**, then:

```bash
okit vault push                 # push keys + agent/provider configs to all enabled platforms
okit vault pull                 # pull the newest copy from each platform and merge
okit vault test cloudflare-kv   # test one platform's connection (e.g. supabase, cloudflare-kv)
```

## 6.2 Auto sync (recommended)

Turn on **Auto Sync** in settings and forget about manual push/pull:

- Local changes (keys, agent configs, provider configs) are **pushed automatically 10 seconds later**
- **All enabled platforms are pushed at once**, backing each other up; pulls always pick the newest copy across platforms
- Remotes are checked **every 5 minutes** and merged if newer (newest-wins by modification time — newer local changes are never overwritten by older data)
- On service start, OKIT merges remotes first, then pushes any unsent local changes
- The first enable pushes once immediately to establish a cloud baseline

## 6.3 LAN device sync

Sync directly between machines on the same LAN — no cloud account needed (Settings → Device Sync → Add device):

- On the always-on machine, choose **Add device → This machine as host**, then copy the `okit-lan://` pairing code
- On the other machine, click **Add device**, paste the code, and **Connect**; both machines must use the **same sync password**
- The device list shows live online status; data is end-to-end encrypted. Re-pair if the host IP changes
- If the firewall blocks the first connection, allow inbound connections for OKIT (LAN sync defaults to port 3790). LAN and cloud sync can be enabled together as mutual backups
