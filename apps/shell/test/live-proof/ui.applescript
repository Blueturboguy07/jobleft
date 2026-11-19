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

on attrText(e, attrName)
	try
		tell application "System Events" to return my textOf(value of attribute attrName of e)
	on error
		return ""
	end try
end attrText

-- One line per element that carries text (role | title or name | value | description), children to a depth of 5.
-- Each element is read on its own, so one element that cannot be read does not hide the others.
on dumpElement(e, depth)
	set out to ""
	set r to my attrText(e, "AXRole")
	set n to my attrText(e, "AXTitle")
	if n is "" then
		try
			tell application "System Events" to set n to my textOf(name of e)
		end try
	end if
	set v to my attrText(e, "AXValue")
	set d to my attrText(e, "AXDescription")
	if n is not "" or v is not "" or d is not "" then set out to out & linefeed & "  " & r & " | " & n & " | " & v & " | " & d
	if depth < 5 then
		try
			tell application "System Events" to set kids to UI elements of e
			repeat with k in kids
				set out to out & my dumpElement(k, depth + 1)
			end repeat
		end try
	end if
	return out
end dumpElement

on dumpProcess(pname)
	tell application "System Events"
		if not (exists process pname) then return "no process " & pname
		set wc to count of windows of process pname
	end tell
	set out to pname & ": " & wc & " window(s)"
	repeat with i from 1 to wc
		tell application "System Events" to set w to window i of process pname
		set out to out & linefeed & "window " & i & ": " & my attrText(w, "AXTitle")
		set out to out & my dumpElement(w, 0)
	end repeat
	return out
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
