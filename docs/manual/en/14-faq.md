# 14. FAQ

**Q: The extension is installed but won't connect?**
The extension auto-detects OKIT's port (tries 3780 and upward). Make sure OKIT is running and the extension isn't disabled in Chrome; if it still fails, restart OKIT and toggle the extension off/on in `chrome://extensions/`.

**Q: Can I dismiss Chrome's "debugging this browser" banner?**
Closing it disconnects the extension. The banner is Chrome's mandatory notice for the debugger permission — it's expected; keep it open.

**Q: Auto-create stopped halfway?**
Most likely the platform popped up a verification (security check / SMS). Complete it manually and the flow resumes; or start over.

**Q: Why can't I see the full key in the vault?**
Keys are stored AES-256-GCM encrypted and masked in the UI by default. Bound projects get the plaintext injected at runtime; you can also reveal the full value on demand.

**Q: Port 3780 is occupied?**
Find the occupant first: `lsof -i :3780`. If it's another program, stop it or let OKIT use another port (the extension auto-detects fallback ports). If it's a leftover OKIT process, kill it and start again.

**Q: Does installing OKIT touch my shell config?**
No. Only an explicit `okit hook install` writes the cd hook; `okit hook uninstall` removes it at any time.

**Q: Multi-machine sync — who wins on conflict?**
Newest modification wins: newer local changes are never overwritten by older remote data. With auto sync you don't need to think about it; manually, `pull` first, then edit, then `push`.

**Q: The model switch didn't take effect in my agent?**
A running CLI session may cache the old config — restart that agent CLI. If it still fails, check what the last switch wrote in Settings → Config History, or restore the previous snapshot.

**Q: How do I migrate to a new machine?**
1. Install OKIT on the new machine and run `okit web`
2. Settings → Cloud Backup: set the same sync password and enable the same platform(s) as the old machine
3. Enable auto sync (or run `okit vault pull`) — keys and agent/provider configs merge in

**Q: Does it support Windows / Linux?**
Yes. OKIT and the extension run on macOS, Linux, and Windows.
