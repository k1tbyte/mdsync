# Runs a program on a desktop of its own: its windows render as usual but never
# reach the screen, so they cannot take focus. Exits when the program does.
param(
	[Parameter(Mandatory)] [string]$Exe,
	[Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
)

Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class HiddenDesktop {
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct StartupInfo {
		public int cb;
		public string reserved, desktop, title;
		public int x, y, width, height, columns, rows, fill, flags;
		public short show, reserved2;
		public IntPtr reserved3, stdIn, stdOut, stdErr;
	}

	[StructLayout(LayoutKind.Sequential)]
	struct ProcessInfo {
		public IntPtr process, thread;
		public int processId, threadId;
	}

	[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, int flags, uint access, IntPtr attributes);

	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	static extern bool CreateProcess(string app, string command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo info);

	[DllImport("kernel32.dll")]
	static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

	[DllImport("kernel32.dll")]
	static extern bool GetExitCodeProcess(IntPtr process, out uint code);

	public static int Run(string command) {
		const string name = "obsync-e2e";
		const uint GenericAll = 0x10000000;
		if (CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GenericAll, IntPtr.Zero) == IntPtr.Zero)
			throw new Win32Exception();
		var startup = new StartupInfo { desktop = name };
		startup.cb = Marshal.SizeOf(startup);
		ProcessInfo info;
		if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, false, 0, IntPtr.Zero, null, ref startup, out info))
			throw new Win32Exception();
		WaitForSingleObject(info.process, uint.MaxValue);
		uint code;
		GetExitCodeProcess(info.process, out code);
		return (int)code;
	}
}
'@

$quoted = @($Exe) + $Arguments | ForEach-Object { '"' + $_ + '"' }
exit [HiddenDesktop]::Run($quoted -join ' ')
