Option Explicit
Dim sh, edge, url, profile, w, h, cmd
If WScript.Arguments.Count < 5 Then WScript.Quit 2
edge = WScript.Arguments(0)
url = WScript.Arguments(1)
profile = WScript.Arguments(2)
w = WScript.Arguments(3)
h = WScript.Arguments(4)
cmd = """" & edge & """ --app=""" & url & """ --user-data-dir=""" & profile & """ --no-first-run --no-default-browser-check --window-size=" & w & "," & h
Set sh = CreateObject("WScript.Shell")
sh.Run cmd, 1, False