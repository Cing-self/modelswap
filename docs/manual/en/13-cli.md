# 13. CLI Cheat Sheet

```bash
okit                            # print help
okit web                        # start the web console (-p port / -o open browser)
okit upgrade                    # upgrade OKIT
okit -V                         # print version

# Vault
okit vault                      # list all keys (same as list)
okit vault set <key> [--stdin]  # store a key (--stdin keeps it out of shell history)
okit vault get <key>            # print plaintext
okit vault list [--json]        # list (--json for scripts/agents)
okit vault delete <key>         # delete
okit vault inject [--keys k1,k2] [--dir <dir>] [--shell zsh]   # print export statements
okit vault env [file] [--dir]   # generate .env from .okitenv and register the binding
okit vault where <key>          # which projects use a key
okit vault sync                 # refresh all associated files
okit vault test <platform>      # test a cloud sync platform connection
okit vault push                 # push keys & configs to the cloud
okit vault pull                 # pull and merge from the cloud

# Shell hook
okit hook install               # auto-inject keys on cd into a project
okit hook uninstall             # remove the hook
okit hook status                # check status

# Providers / models
okit provider list [--json]     # list all providers
okit provider switch [agent]    # interactive switch
okit provider use <p> [--agent <a>] [--model <m>]   # non-interactive switch
okit provider add               # add a provider
okit provider delete <name>     # delete a provider
okit provider current [--json]  # current config of all agents
okit provider auth [--json]     # auth status

# Agent skill (let AI agents drive OKIT)
okit skill path                 # print the built-in skill file path
okit skill install [dir]        # install into a project's .agents/skills/okit-cli
```
