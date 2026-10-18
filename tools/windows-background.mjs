import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function powershell(script) {
  return execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8", timeout: 30_000 }).trim();
}

/** Hosted-runner probe: inspect visible console windows, without recording titles. */
export function visibleWindowsConsoles() {
  if (process.platform !== "win32") return [];
  const output = powershell(`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PdmuxConsoleWindows {
  public delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  public static string[] Visible() {
    var windows = new List<string>();
    bool completed = EnumWindows((window, state) => {
      if (!IsWindowVisible(window)) return true;
      var name = new StringBuilder(256);
      GetClassName(window, name, name.Capacity);
      if (name.ToString() == "ConsoleWindowClass" || name.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") windows.Add(window.ToInt64().ToString());
      return true;
    }, IntPtr.Zero);
    if (!completed) throw new InvalidOperationException("Cannot enumerate desktop windows");
    return windows.ToArray();
  }
}
'@
ConvertTo-Json -Compress -InputObject @([PdmuxConsoleWindows]::Visible())
`);
  return JSON.parse(output);
}

export function assertNoRuntimeConsoles(baseline) {
  const previous = new Set(baseline);
  assert.deepEqual(visibleWindowsConsoles().filter(handle => !previous.has(handle)), [], "[TC-PDDESKTOP-021] embedded runtime creates no visible console windows");
}

export function windowsRuntimeChildren(parentPid) {
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0);
  const output = powershell(`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Where-Object { $_.Name -eq 'bun.exe' } | ForEach-Object { [int]$_.ProcessId })`);
  return JSON.parse(output);
}
