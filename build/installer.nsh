!include WinVer.nsh
!include x64.nsh

; Match the supported platforms of the bundled Electron runtime. Reject before
; the install-mode wizard, not after copying an executable that cannot run.
!macro fanduUnsupportedWindows
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "番渡需要 Windows 10 或更新版本（64 位 x64 / ARM64）。$\r$\nFandu requires 64-bit Windows 10 or later (x64 / ARM64)."
  SetErrorLevel 1633
  Quit
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    ${IfNot} ${AtLeastWin10}
      !insertmacro fanduUnsupportedWindows
    ${EndIf}
    ${IfNot} ${RunningX64}
      ${IfNot} ${IsNativeARM64}
        !insertmacro fanduUnsupportedWindows
      ${EndIf}
    ${EndIf}
  !endif
!macroend
