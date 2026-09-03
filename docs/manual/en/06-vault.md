# 6. Working with the Vault

![Vault page](../images/vault.png)

- **Add manually**: Vault → Add; give the key a name, paste the value, optionally add a note
- **Viewing**: keys are masked by default; the full value can be revealed on demand. Keys are stored encrypted (AES-256-GCM) under `~/.modelswap` on your machine
- **Command line**:

```bash
modelswap vault list                  # list all keys (masked)
modelswap vault set <key>             # store a key (interactive, recommended)
printf '%s' "$SECRET" | modelswap vault set <key> --stdin   # automation: keeps the secret out of shell history
modelswap vault get <key>             # print plaintext
modelswap vault delete <key>          # delete
modelswap vault inject [--shell zsh]  # print export statements (use with eval)
```
