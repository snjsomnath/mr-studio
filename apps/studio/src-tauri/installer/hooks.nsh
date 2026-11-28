; MR Studio's Windows setup look (#695).
;
; Tauri includes this file near the top of its installer.nsi: after MUI2.nsh, before any page.
; tauri.conf.json sets the Welcome picture (sidebar.bmp) and the header picture (header.bmp).
; This file adds two things the config can't:
;   1. While the files copy, a slideshow of what MR Studio does plays where the details list was.
;      It is an AVI in the Windows animation control (SysAnimate32), which plays on its own thread,
;      so no NSIS code runs during the install (NSIS has no safe timer there).
;   2. The Finish page gets its own picture (finish.bmp) instead of repeating the Welcome one.
; Pictures and slides are made by scripts/installer-art.mjs. Edit that, not the files here.

!include LogicLib.nsh

!define MRS_ART "${__FILEDIR__}"

; MUI2 has no setting for a Show function on the progress page, and Tauri's template inserts the
; page without one. Wrap the installer's MUI_PAGE_INSTFILES (the uninstaller uses its own macro)
; so its page calls MrsSlidesShow. Same body as MUI2's, plus the define.
!macroundef MUI_PAGE_INSTFILES
!macro MUI_PAGE_INSTFILES
  !verbose push
  !verbose ${MUI_VERBOSE}
  !insertmacro MUI_PAGE_INIT
  !ifndef MUI_PAGE_CUSTOMFUNCTION_SHOW
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW MrsSlidesShow
  !endif
  !insertmacro MUI_PAGEDECLARATION_INSTFILES
  !verbose pop
!macroend

Function MrsSlidesShow
  ; The page's own dialog, its details list (1016) and its "Show details" button (1027).
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1016
  GetDlgItem $2 $0 1027
  ${If} $1 == 0
    Return
  ${EndIf}

  ; Where the list sits, in the page's coordinates: the slideshow takes its place.
  System::Call "*(i, i, i, i) p.r3"
  System::Call "user32::GetWindowRect(p r1, p r3)"
  System::Call "user32::MapWindowPoints(p 0, p r0, p r3, i 2)"
  System::Call "*$3(i .r4, i .r5, i .r6, i .r7)"
  System::Free $3
  IntOp $6 $6 - $4 ; width
  IntOp $7 $7 - $5 ; height

  ; Pick the slides made for this screen's scaling: the largest that fits the list's space.
  ${If} $6 >= 880
    File "/oname=$PLUGINSDIR\mrs-slides.avi" "${MRS_ART}\slides-200.avi"
  ${ElseIf} $6 >= 660
    File "/oname=$PLUGINSDIR\mrs-slides.avi" "${MRS_ART}\slides-150.avi"
  ${Else}
    File "/oname=$PLUGINSDIR\mrs-slides.avi" "${MRS_ART}\slides-100.avi"
  ${EndIf}

  ; WS_CHILD | WS_VISIBLE | ACS_CENTER | ACS_TRANSPARENT | ACS_AUTOPLAY
  System::Call "user32::CreateWindowExW(i 0, w 'SysAnimate32', w '', i 0x50000007, i r4, i r5, i r6, i r7, p r0, p 0, p 0, p 0) p.r8"
  ${If} $8 == 0
    Return ; no animation control: leave the page as it was
  ${EndIf}
  ; ACM_OPENW
  SendMessage $8 0x467 0 "STR:$PLUGINSDIR\mrs-slides.avi" $9
  ${If} $9 == 0
    System::Call "user32::DestroyWindow(p r8)"
    Return
  ${EndIf}
  ShowWindow $1 ${SW_HIDE}
  ShowWindow $2 ${SW_HIDE}
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ; The Finish page reads its picture from this file when it opens.
  File "/oname=$PLUGINSDIR\modern-wizard.bmp" "${MRS_ART}\finish.bmp"
!macroend
