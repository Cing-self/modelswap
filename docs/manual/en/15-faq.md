# 15. FAQ

**Q: The extension is installed but won't connect?**
The extension auto-detects ModelSwap's port (tries 3780 and upward). Make sure ModelSwap is running and the extension isn't disabled in Chrome; if it still fails, restart ModelSwap and toggle the extension off/on in `chrome://extensions/`.

**Q: Can I dismiss Chrome's "debugging this browser" banner?**
Closing it disconnects the extension. The banner is Chrome's mandatory notice for the debugger permission — it's expected; keep it open.

**Q: Auto-create stopped halfway?**
Most likely the platform popped up a verification (security check / SMS). Complete it manually and the flow resumes; or start over.

**Q: Why can't I see the full key in the vault?**
Keys are stored AES-256-GCM encrypted and masked in the UI by default. Bound projects get the plaintext injected at runtime; you can also reveal the full value on demand.

**Q: Port 3780 is occupied?**
Find the occupant first: `lsof -i :3780`. If it's another program, stop it or let ModelSwap use another port (the extension auto-detects fallback ports). If it's a leftover ModelSwap process, kill it and start again.

**Q: Does installing ModelSwap touch my shell config?**
No. No ModelSwap feature writes to your shell config. (The `modelswap hook` command was removed in v1.0.3 — the project-binding injection it served had already been deleted. If an older version installed the hook: open `~/.zshrc` / `~/.bashrc` and delete everything between the `# >>> modelswap-hook >>>` and `# <<< modelswap-hook <<<` markers.)

**Q: Multi-machine sync — who wins on conflict?**
Newest modification wins: newer local changes are never overwritten by older remote data. With auto sync you don't need to think about it; manually, `pull` first, then edit, then `push`.

**Q: The model switch didn't take effect in my agent?**
A running CLI session may cache the old config — restart that agent CLI. If it still fails, check what the last switch wrote in Settings → Config History, or restore the previous snapshot.

**Q: How do I migrate to a new machine?**
1. Install ModelSwap on the new machine and run `modelswap web`
2. Settings → Cloud Backup: set the same sync password and enable the same platform(s) as the old machine
3. Enable auto sync (or run `modelswap vault pull`) — keys and agent/provider configs merge in

**Q: Does it support Windows / Linux?**
Yes. ModelSwap and the extension run on macOS, Linux, and Windows.
