// Toolhelp and process handles avoid a dependency on the WMI/CIM service.
// Termination checks creation time and uses that same handle, preventing PID reuse races.
export const windowsProcessApi = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class MagiProcesses {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Entry {
    public uint Size, Usage, ProcessId;
    public UIntPtr Heap;
    public uint Module, Threads, ParentProcessId;
    public int Priority;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string Name;
  }
  public sealed class ProcessInfo {
    public uint ProcessId, ParentProcessId;
    public DateTime CreationDate;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process, uint timeout);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static Entry[] Snapshot() {
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      var entries = new List<Entry>();
      var entry = new Entry { Size = (uint)Marshal.SizeOf(typeof(Entry)) };
      if (Process32FirstW(snapshot, ref entry)) {
        do { entries.Add(entry); } while (Process32NextW(snapshot, ref entry));
      }
      var error = Marshal.GetLastWin32Error();
      if (error != 18) throw new Win32Exception(error); // ERROR_NO_MORE_FILES
      return entries.ToArray();
    } finally { CloseHandle(snapshot); }
  }
  static IntPtr Open(uint pid, uint access) {
    var handle = OpenProcess(access, false, pid);
    if (handle != IntPtr.Zero) return handle;
    var error = Marshal.GetLastWin32Error();
    if (error == 87) return IntPtr.Zero; // Process already gone.
    throw new Win32Exception(error);
  }
  static DateTime Created(IntPtr handle) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return DateTime.FromFileTimeUtc(created);
  }
  public static ProcessInfo Inspect(uint pid) {
    var handle = Open(pid, 0x1000); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) return null;
    try {
      var created = Created(handle);
      foreach (var entry in Snapshot()) {
        if (entry.ProcessId == pid)
          return new ProcessInfo { ProcessId = pid, ParentProcessId = entry.ParentProcessId, CreationDate = created };
      }
      return null;
    } finally { CloseHandle(handle); }
  }
  public static void Stop(uint pid, DateTime created) {
    var handle = Open(pid, 0x1000 | 0x100000 | 1); // QUERY | SYNCHRONIZE | TERMINATE
    if (handle == IntPtr.Zero) return;
    try {
      if (Created(handle) != created) throw new InvalidOperationException("Owned process PID was reused; refusing termination");
      if (WaitForSingleObject(handle, 0) == 0) return;
      if (!TerminateProcess(handle, 1) && WaitForSingleObject(handle, 0) != 0)
        throw new Win32Exception(Marshal.GetLastWin32Error());
      if (WaitForSingleObject(handle, 5000) != 0) throw new InvalidOperationException("Owned process did not exit");
    } finally { CloseHandle(handle); }
  }
}
'@
`
