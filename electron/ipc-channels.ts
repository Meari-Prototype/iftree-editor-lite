// IPC channel 名集中表——main（注册/推送侧）与 preload（暴露/监听侧）共用。
// 抽出来防两边字符串拼写错位：main 改了 channel 名 preload 不知道 = 调用静默失败。

export default {
  // window
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggleMaximize',
  WINDOW_CLOSE: 'window:close',

  // entity
  ENTITY_OPEN_MAINTENANCE_WINDOW: 'entity:openMaintenanceWindow',

  // OS-backed settings picker
  SETTINGS_CHOOSE_LOCAL_MODEL_ROOT: 'settings:chooseLocalModelRoot',

  // OS 能力：在系统文件管理器中显示路径（设置屏「常规 → 存储目录」用）
  SHELL_OPEN_PATH: 'shell:openPath',

  // OS-backed import picker
  IMPORT_CHOOSE_FILE: 'import:chooseFile',

  // 显示器/界面缩放指标（PDF canvas 出图密度用）
  APP_DISPLAY_METRICS: 'app:displayMetrics',

  // shell → entity window
  MENU_ACTION: 'menu:action'
} as const;
