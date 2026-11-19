-- UI driver for the live update proof on a GitHub macOS runner (apps/shell/test/live-proof/macos.sh). It does what a
-- person does with the mouse: reads a dialog, clicks one of its buttons, opens the menu bar item's menu and clicks an
-- item. System Events needs the Accessibility permission, which the GitHub macOS runner image grants to the runner.
--
--   osascript ui.applescript dump  <process>                every window: role, name and value of each element
--   osascript ui.applescript click <process> <button>       clicks the first button with that name, in any window
--   osascript ui.applescript menu  <process> <item prefix>  opens the menu bar (status) item, clicks the first item
--                                                           whose name starts with the prefix
-- Prints what it did; "no ..." when there was nothing to click.

on run argv
	set cmd to item 1 of argv
	if cmd is "dump" then return dumpProcess(item 2 of argv)
	if cmd is "click" then return clickButton(item 2 of argv, item 3 of argv)
	if cmd is "menu" then return clickStatusMenu(item 2 of argv, item 3 of argv)
	error "unknown command " & cmd
end run

on textOf(x)
	try
		if x is missing value then return ""
		return x as text
	on error
		return ""
	end try
end textOf

on dumpProcess(pname)
	tell application "System Events"
		if not (exists process pname) then return "no process " & pname
		tell process pname
			set wc to count of windows
			set out to pname & ": " & wc & " window(s)"
			repeat with i from 1 to wc
				set w to window i
				set out to out & linefeed & "window " & i & ": " & my textOf(name of w)
				try
					repeat with e in (entire contents of w)
						set r to ""
						set n to ""
						set v to ""
						try
							set r to my textOf(role of e)
						end try
						try
							set n to my textOf(name of e)
						end try
						try
							set v to my textOf(value of e)
						end try
						if n is not "" or v is not "" then set out to out & linefeed & "  " & r & " | " & n & " | " & v
					end repeat
				end try
			end repeat
			return out
		end tell
	end tell
end dumpProcess

on clickButton(pname, bname)
	tell application "System Events"
		if not (exists process pname) then return "no process " & pname
		tell process pname
			repeat with i from 1 to (count of windows)
				set w to window i
				if exists button bname of w then
					click button bname of w
					return "clicked " & bname & " in window " & i
				end if
				try
					repeat with e in (entire contents of w)
						try
							if (role of e) is "AXButton" and (my textOf(name of e)) is bname then
								click e
								return "clicked " & bname & " in window " & i
							end if
						end try
					end repeat
				end try
			end repeat
		end tell
	end tell
	return "no button " & bname
end clickButton

on clickStatusMenu(pname, prefix)
	tell application "System Events"
		if not (exists process pname) then return "no process " & pname
		if not (exists menu bar 2 of process pname) then return "no menu bar item of " & pname
	end tell
	-- Opening a menu bar item's menu blocks the caller until the menu closes; System Events is restarted to get on.
	ignoring application responses
		tell application "System Events" to click menu bar item 1 of menu bar 2 of process pname
	end ignoring
	delay 1
	do shell script "killall 'System Events' 2>/dev/null || true"
	delay 1
	tell application "System Events"
		tell process pname
			set m to menu 1 of menu bar item 1 of menu bar 2
			set seen to ""
			repeat with mi in (menu items of m)
				set n to my textOf(name of mi)
				set seen to seen & "[" & n & "] "
				if n starts with prefix then
					click mi
					return "clicked " & n & " (the menu: " & seen & ")"
				end if
			end repeat
			key code 53
			return "no menu item " & prefix & " (the menu: " & seen & ")"
		end tell
	end tell
end clickStatusMenu
