import fs from "fs-extra";
import path from "path";
import os from "os";
import kleur from "kleur";

type ShellType = "zsh" | "bash" | "powershell";

const MARKER_START = "# >>> okit-hook >>>";
const MARKER_END = "# <<< okit-hook <<<";
const PS_MARKER_START = "# >>> okit-hook >>>";
const PS_MARKER_END = "# <<< okit-hook <<<";

function detectShell(): ShellType {
  if (process.platform === "win32") return "powershell";
  const shell = process.env.SHELL || "";
  if (shell.includes("zsh")) return "zsh";
  return "bash";
}

function getRcFile(shell: ShellType): string {
  const home = os.homedir();
  switch (shell) {
    case "zsh": return path.join(home, ".zshrc");
    case "bash": return path.join(home, ".bashrc");
    case "powershell": {
      const psDir = path.join(home, "Documents", "PowerShell");
      return path.join(psDir, "Microsoft.PowerShell_profile.ps1");
    }
  }
}

function getHookScript(shell: ShellType): string {
  switch (shell) {
    case "zsh": return `${MARKER_START}
_okit_inject() {
  local _okit_env=""
  if [ -f "\${PWD}/.okitenv" ]; then _okit_env="\${PWD}/.okitenv"
  elif [ -f "\${PWD}/.okit-env" ]; then _okit_env="\${PWD}/.okit-env"
  fi
  if [ -z "\$_okit_env" ]; then
    if [ -n "\$_OKIT_LOADED_KEYS" ]; then
      for _k in \$_OKIT_LOADED_KEYS; do unset "\$_k"; done
      unset _OKIT_LOADED_KEYS _OKIT_LOADED_DIR _OKIT_LOADED_MTIME
    fi
    return
  fi
  local _mt=\$(stat -f %m "\$_okit_env" 2>/dev/null || echo 0)
  if [ "\$_OKIT_LOADED_DIR" = "\$PWD" ] && [ "\$_OKIT_LOADED_MTIME" = "\$_mt" ]; then
    return
  fi
  if [ -n "\$_OKIT_LOADED_KEYS" ]; then
    for _k in \$_OKIT_LOADED_KEYS; do unset "\$_k"; done
  fi
  eval "\$(okit vault inject --dir "\$PWD" 2>/dev/null)" 2>/dev/null || true
  _OKIT_LOADED_MTIME="\$_mt"
  export _OKIT_LOADED_MTIME
}
_okit_chpwd() { _okit_inject; }
chpwd_functions+=(_okit_chpwd)
precmd_functions+=(_okit_inject)
${MARKER_END}`;

    case "bash": return `${MARKER_START}
_okit_inject() {
  local _okit_env=""
  if [ -f "\${PWD}/.okitenv" ]; then _okit_env="\${PWD}/.okitenv"
  elif [ -f "\${PWD}/.okit-env" ]; then _okit_env="\${PWD}/.okit-env"
  fi
  if [ -z "\$_okit_env" ]; then
    if [ -n "\$_OKIT_LOADED_KEYS" ]; then
      for _k in \$_OKIT_LOADED_KEYS; do unset "\$_k"; done
      unset _OKIT_LOADED_KEYS _OKIT_LOADED_DIR _OKIT_LOADED_MTIME
    fi
    return
  fi
  local _mt=\$(stat -c %Y "\$_okit_env" 2>/dev/null || stat -f %m "\$_okit_env" 2>/dev/null || echo 0)
  if [ "\$_OKIT_LOADED_DIR" = "\$PWD" ] && [ "\$_OKIT_LOADED_MTIME" = "\$_mt" ]; then
    return
  fi
  if [ -n "\$_OKIT_LOADED_KEYS" ]; then
    for _k in \$_OKIT_LOADED_KEYS; do unset "\$_k"; done
  fi
  eval "\$(okit vault inject --dir "\$PWD" 2>/dev/null)" 2>/dev/null || true
  export _OKIT_LOADED_MTIME="\$_mt"
}
_okit_prompt_hook() {
  _okit_inject
}
PROMPT_COMMAND="_okit_prompt_hook\${PROMPT_COMMAND:+;\$PROMPT_COMMAND}"
${MARKER_END}`;

    case "powershell": return `${PS_MARKER_START}
\$global:_okitPrevDir = ""
\$global:_okitOrigPrompt = \$function:prompt
function global:prompt {
  \$okitEnv = Join-Path \$PWD ".okitenv"
  \$okitEnv2 = Join-Path \$PWD ".okit-env"
  if (-not (Test-Path \$okitEnv) -and -not (Test-Path \$okitEnv2)) {
    if (\$global:_OKIT_LOADED_KEYS) {
      foreach (\$k in \$global:_OKIT_LOADED_KEYS.Split(" ")) {
        Remove-Item -Path "env:\$k" -ErrorAction SilentlyContinue
      }
      \$global:_OKIT_LOADED_KEYS = \$null
      \$global:_OKIT_LOADED_DIR = \$null
      \$global:_OKIT_LOADED_MTIME = \$null
    }
  } else {
    \$envFile = if (Test-Path \$okitEnv) { \$okitEnv } else { \$okitEnv2 }
    \$mt = (Get-Item \$envFile).LastWriteTimeUtc.Ticks
    if (\$global:_OKIT_LOADED_DIR -ne \$PWD.Path -or \$global:_OKIT_LOADED_MTIME -ne \$mt) {
      if (\$global:_OKIT_LOADED_KEYS) {
        foreach (\$k in \$global:_OKIT_LOADED_KEYS.Split(" ")) {
          Remove-Item -Path "env:\$k" -ErrorAction SilentlyContinue
        }
      }
      try {
        \$output = okit vault inject --dir "\$PWD" --shell powershell 2>\$null
        if (\$output) { \$output | ForEach-Object { Invoke-Expression \$_ } }
        \$global:_OKIT_LOADED_MTIME = \$mt
      } catch {}
    }
  }
  & \$global:_okitOrigPrompt
}
${PS_MARKER_END}`;
  }
}

function getMarkerStart(shell: ShellType): string {
  return shell === "powershell" ? PS_MARKER_START : MARKER_START;
}

function getMarkerEnd(shell: ShellType): string {
  return shell === "powershell" ? PS_MARKER_END : MARKER_END;
}

function hasOkitEnv(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".okitenv")) || fs.existsSync(path.join(dir, ".okit-env"));
}

export async function hookInstall(): Promise<void> {
  const shell = detectShell();
  const rcFile = getRcFile(shell);
  const rcName = path.relative(os.homedir(), rcFile);
  const script = getHookScript(shell);
  const markerStart = getMarkerStart(shell);

  if (!(await fs.pathExists(rcFile))) {
    await fs.ensureDir(path.dirname(rcFile));
    await fs.writeFile(rcFile, "", { mode: 0o644 });
  }

  const content = await fs.readFile(rcFile, "utf-8");

  if (content.includes(markerStart)) {
    console.log(kleur.yellow(`okit hook 已安装在 ${rcName} 中`));
    return;
  }

  const newContent = content.trimEnd() + "\n\n" + script + "\n";
  await fs.writeFile(rcFile, newContent);

  console.log(kleur.green(`okit hook 已安装到 ${rcName} (${shell})`));
  if (shell === "powershell") {
    console.log(kleur.gray(`  重新打开 PowerShell 生效`));
  } else {
    console.log(kleur.gray(`  重新打开终端或运行 source ~/${rcName} 生效`));
  }
}

export async function hookUninstall(): Promise<void> {
  const shell = detectShell();
  const rcFile = getRcFile(shell);
  const rcName = path.relative(os.homedir(), rcFile);
  const markerStart = getMarkerStart(shell);
  const markerEnd = getMarkerEnd(shell);

  if (!(await fs.pathExists(rcFile))) {
    console.log(kleur.yellow("未找到 shell 配置文件"));
    return;
  }

  const content = await fs.readFile(rcFile, "utf-8");

  if (!content.includes(markerStart)) {
    console.log(kleur.yellow("okit hook 未安装"));
    return;
  }

  const lines = content.split("\n");
  const filtered: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (line.trim() === markerStart) { skipping = true; continue; }
    if (line.trim() === markerEnd) { skipping = false; continue; }
    if (!skipping) filtered.push(line);
  }

  await fs.writeFile(rcFile, filtered.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n");
  console.log(kleur.green(`okit hook 已从 ${rcName} 移除`));
}

export async function hookStatus(): Promise<void> {
  const shell = detectShell();
  const rcFile = getRcFile(shell);
  const rcName = path.relative(os.homedir(), rcFile);
  const markerStart = getMarkerStart(shell);

  let installed = false;
  if (await fs.pathExists(rcFile)) {
    const content = await fs.readFile(rcFile, "utf-8");
    installed = content.includes(markerStart);
  }

  console.log(kleur.cyan("\nokit hook 状态\n"));
  console.log(`  安装状态: ${installed ? kleur.green("已安装") : kleur.red("未安装")}`);
  console.log(`  配置文件: ${rcName}`);
  console.log(`  检测 shell: ${shell}`);

  if (hasOkitEnv(process.cwd())) {
    console.log(`  当前目录: ${kleur.green("检测到 .okitenv")}`);
  }
  console.log();
}

// Export for other modules
export { detectShell };
