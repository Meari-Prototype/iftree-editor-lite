; IF-Tree Editor Lite 启动器（免安装一键启动）
; 逻辑：先探测依赖——node_modules 不在才弹卡片装依赖；在则直接拉起应用、启动器即退。
; 全程不弹 cmd 黑框：npm 经 nsExec（隐藏控制台）跑，应用经直接拉起 electron.exe。
; 编译：makensis iftree-launcher.nsi → iftree.exe（几十 KB，自包含）

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "IF-Tree Editor"
OutFile "iftree.exe"
Unicode true

; exe 文件图标 + 安装器界面图标，都用项目 UI 的 ListTree 标识
!define MUI_ICON "iftree.ico"
RequestExecutionLevel user
SetCompress auto
SetCompressor /SOLID lzma
ShowInstDetails nevershow          ; 不缺依赖时永不弹安装页（静默拉起）
AutoCloseWindow true               ; 装完自动关，不留「安装完成」窗

; 只有真正要装依赖时这个页才出现（.onInit 里缺依赖才改 ShowInstDetails）
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "MainSection" SEC01
  SetOutPath "$EXEDIR"

  ; —— 装依赖（仅当 .onInit 判定缺 node_modules 才走到这；不缺则被跳过）——
  IfFileExists "$EXEDIR\node_modules\*.*" Launch
    DetailPrint "首次运行，正在安装依赖（可能需要几分钟）…"
    nsExec::ExecToLog 'cmd /c npm install'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "依赖安装失败（退出码 $0）。请确认已装 Node.js 并加入 PATH。"
      Abort
    ${EndIf}
    DetailPrint "正在构建前端…"
    nsExec::ExecToLog 'cmd /c npm run build'
    Pop $0
    ${If} $0 != 0
      MessageBox MB_ICONSTOP|MB_OK "前端构建失败（退出码 $0）。"
      Abort
    ${EndIf}

Launch:
  ; 直接拉起 Electron（不经 cmd 管道）：应用生命周期由 Electron 自己管，
  ; 其 web-shell 负责起 web server。启动器拉起即退、不占进程。
  Exec '"$EXEDIR\node_modules\electron\dist\electron.exe" "dist/electron/web-shell.js"'
  ; 显式退出：避免启动器作为父进程残留在后台（Exec 不等，但 section 结束
  ; 有时不立即退）。Quit 立即终止安装器进程，不留窗口不留进程。
  Quit
SectionEnd

Function .onInit
  ; 关键：缺依赖才显示安装卡片；不缺则保持 nevershow，section 内 Exec 拉起即退。
  IfFileExists "$EXEDIR\node_modules\*.*" HasDeps
    SetDetailsView show             ; 缺依赖：显示卡片 + 日志区
    BringToFront
  HasDeps:
FunctionEnd
