; The pinned Tauri CLI includes hooks after utils.nsh. Replace its force-stop
; macro with a read-only check; never call RmShutdown or terminate an owner.
!include "${__FILEDIR__}\installer-guard.generated.nsh"
Var NuPhyLabInstallGate

!macro NuPhyLabAcquireInstallGate
  ${If} $NuPhyLabInstallGate == ""
    Push $8
    Push $9
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "${NUPHYLAB_INSTALL_MUTEX}") p.r8 ?e'
    Pop $9
    ${If} $8 == 0
      Pop $9
      Pop $8
      SetErrorLevel 2
      Abort "Cannot protect the installation. Please retry."
    ${EndIf}
    ${If} $9 == 183
      System::Call 'kernel32::CloseHandle(p r8)'
      Pop $9
      Pop $8
      SetErrorLevel 2
      Abort "Another NuPhy Lab installer is running."
    ${EndIf}
    StrCpy $NuPhyLabInstallGate $8
    Pop $9
    Pop $8
  ${EndIf}
!macroend

!macro NuPhyLabReleaseInstallGate
  ${If} $NuPhyLabInstallGate != ""
    System::Call 'kernel32::CloseHandle(p $NuPhyLabInstallGate)'
    StrCpy $NuPhyLabInstallGate ""
  ${EndIf}
!macroend

!ifmacrondef CheckIfAppIsRunning
  !error "The pinned Tauri installer contract changed; review process protection."
!endif
!macroundef CheckIfAppIsRunning
!macro CheckIfAppIsRunning executablePath productName
  Push $8
  Push $9
  nsExec::ExecToStack /TIMEOUT=25000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -EncodedCommand "${NUPHYLAB_PROCESS_CHECK}"'
  Pop $8
  Pop $9
  ${If} $8 != 0
    Pop $9
    Pop $8
    IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "Please close NuPhy Lab normally, wait for keyboard restoration, then retry. / 请正常退出 NuPhy Lab，等待键盘恢复后重试。"
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $9
  Pop $8
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro NuPhyLabAcquireInstallGate
!macroend
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro NuPhyLabReleaseInstallGate
!macroend
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro NuPhyLabAcquireInstallGate
!macroend
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro NuPhyLabReleaseInstallGate
!macroend
