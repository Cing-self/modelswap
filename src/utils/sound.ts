import { execSync } from "child_process";

/**
 * 播放提示音
 * 使用 macOS 系统提示音或蜂鸣声
 */
export function playSound(type: "success" | "error" | "warning" | "input" = "success") {
  try {
    // 使用 macOS 的 afplay 播放系统提示音
    const soundFiles: Record<string, string> = {
      success: "/System/Library/Sounds/Glass.aiff",
      error: "/System/Library/Sounds/Basso.aiff",
      warning: "/System/Library/Sounds/Ping.aiff",
      input: "/System/Library/Sounds/Tink.aiff",
    };

    const soundFile = soundFiles[type];
    if (soundFile) {
      // 后台播放，不阻塞程序
      execSync(`afplay "${soundFile}" &`, { stdio: "ignore" });
    }
  } catch {
    // 如果 afplay 失败，使用蜂鸣声作为备选
    process.stdout.write("\x07");
  }
}

/**
 * 蜂鸣声（最简单的方式，跨平台）
 */
export function beep() {
  process.stdout.write("\x07");
}
