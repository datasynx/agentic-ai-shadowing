/**
 * Window Detector — detects the currently active window on the user's desktop.
 *
 * Supports:
 * - Linux (X11): xdotool + xprop
 * - macOS: osascript (AppleScript)
 * - Windows: PowerShell + user32.dll (GetForegroundWindow P/Invoke)
 * - Fallback: returns null (headless/Wayland/unsupported)
 *
 * Does NOT require any npm dependencies — uses native OS commands.
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { WindowInfo } from './observer.js';

// ── Platform Detection ──────────────────────────────────────────────────────

export type DetectorPlatform = 'linux-x11' | 'macos' | 'windows' | 'unsupported';

export function detectPlatform(): DetectorPlatform {
  const os = platform();
  if (os === 'darwin') return 'macos';
  if (os === 'win32') return 'windows';
  if (os === 'linux') {
    // Check if X11 is available (Wayland won't have DISPLAY or xdotool)
    if (process.env['DISPLAY'] || process.env['XAUTHORITY']) {
      try {
        execSync('which xdotool', { stdio: 'ignore' });
        return 'linux-x11';
      } catch {
        return 'unsupported';
      }
    }
    return 'unsupported';
  }
  return 'unsupported';
}

// ── Linux X11 Detector ──────────────────────────────────────────────────────

function detectWindowLinux(): WindowInfo | null {
  try {
    // Get active window ID
    const windowId = execSync('xdotool getactivewindow', {
      timeout: 2000,
      encoding: 'utf8',
    }).trim();

    if (!windowId) return null;

    // Get window title
    const title = execSync(`xdotool getactivewindow getwindowname`, {
      timeout: 2000,
      encoding: 'utf8',
    }).trim();

    // Get WM_CLASS (application name) via xprop
    let appName = 'unknown';
    try {
      const xpropOutput = execSync(`xprop -id ${windowId} WM_CLASS`, {
        timeout: 2000,
        encoding: 'utf8',
      }).trim();
      // Format: WM_CLASS(STRING) = "instance", "class"
      const classMatch = xpropOutput.match(/WM_CLASS\(STRING\)\s*=\s*"[^"]*",\s*"([^"]*)"/);
      if (classMatch?.[1]) {
        appName = classMatch[1];
      }
    } catch {
      // xprop might not be available — use PID-based detection
      try {
        const pid = execSync(`xdotool getactivewindow getwindowpid`, {
          timeout: 2000,
          encoding: 'utf8',
        }).trim();
        if (pid) {
          const comm = execSync(`cat /proc/${pid}/comm`, {
            timeout: 1000,
            encoding: 'utf8',
          }).trim();
          if (comm) appName = comm;
        }
      } catch {
        // Fallback: extract app name from title
        appName = extractAppFromTitle(title);
      }
    }

    return { app_name: appName, window_title: title };
  } catch {
    return null;
  }
}

// ── macOS Detector ──────────────────────────────────────────────────────────

function detectWindowMacOS(): WindowInfo | null {
  try {
    const script = `
      tell application "System Events"
        set frontApp to first application process whose frontmost is true
        set appName to name of frontApp
        set winTitle to ""
        try
          set winTitle to name of front window of frontApp
        end try
        return appName & "|||" & winTitle
      end tell
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: 3000,
      encoding: 'utf8',
    }).trim();

    const [appName, windowTitle] = result.split('|||');
    if (!appName) return null;

    return {
      app_name: appName,
      window_title: windowTitle ?? appName,
    };
  } catch {
    return null;
  }
}

// ── Windows Detector ────────────────────────────────────────────────────────

/**
 * PowerShell script that uses P/Invoke to call user32.dll:
 * - GetForegroundWindow() → window handle
 * - GetWindowText() → window title
 * - GetWindowThreadProcessId() → PID → process name
 *
 * Returns JSON: {"title":"...","processName":"...","processId":123}
 */
const PS_WINDOW_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32FG {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$h=[Win32FG]::GetForegroundWindow()
$t=New-Object System.Text.StringBuilder 256
[void][Win32FG]::GetWindowText($h,$t,256)
$p=[uint32]0
[void][Win32FG]::GetWindowThreadProcessId($h,[ref]$p)
$pr=Get-Process -Id $p -ErrorAction SilentlyContinue
@{title=$t.ToString();processName=$(if($pr){$pr.ProcessName}else{''});processId=$p}|ConvertTo-Json -Compress
`.trim();

/**
 * Parse the JSON output from the PowerShell window detection script.
 */
export function parseWindowsPSOutput(output: string): WindowInfo | null {
  try {
    const data = JSON.parse(output.trim()) as {
      title: string;
      processName: string;
      processId: number;
    };

    if (!data.title && !data.processName) return null;

    return {
      app_name: data.processName || extractAppFromTitle(data.title),
      window_title: data.title || data.processName,
    };
  } catch {
    return null;
  }
}

function detectWindowWindows(): WindowInfo | null {
  try {
    const output = execSync(
      `powershell.exe -NoProfile -NoLogo -NonInteractive -Command "${PS_WINDOW_SCRIPT.replace(/"/g, '\\"')}"`,
      {
        timeout: 5000,
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim();

    return parseWindowsPSOutput(output);
  } catch {
    return null;
  }
}

// ── Helper ──────────────────────────────────────────────────────────────────

function extractAppFromTitle(title: string): string {
  // Common patterns: "file.ts — VS Code", "Terminal — bash", "Google Chrome"
  // Windows patterns: "Document.docx - Microsoft Word", "Untitled - Notepad"
  const dashMatch = title.match(/\s[—–-]\s+(.+)$/);
  if (dashMatch?.[1]) return dashMatch[1];
  return title.split(/\s/)[0] ?? 'unknown';
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Creates a window detector function appropriate for the current platform.
 * Returns null if the platform is not supported (headless, Wayland, etc.)
 */
export function createWindowDetector(): (() => Promise<WindowInfo | null>) | null {
  const plat = detectPlatform();

  switch (plat) {
    case 'linux-x11':
      return async () => detectWindowLinux();
    case 'macos':
      return async () => detectWindowMacOS();
    case 'windows':
      return async () => detectWindowWindows();
    case 'unsupported':
      return null;
  }
}

/**
 * Single-shot: detect the current active window right now.
 */
export function detectActiveWindow(): WindowInfo | null {
  const plat = detectPlatform();
  switch (plat) {
    case 'linux-x11': return detectWindowLinux();
    case 'macos': return detectWindowMacOS();
    case 'windows': return detectWindowWindows();
    default: return null;
  }
}
