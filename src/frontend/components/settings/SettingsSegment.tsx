// 分段按钮组：少量互斥选项的设置项用（权限档位、配色主题等）。
// 从 GeneralSettingsPanel 抽成共享件——外观页与常规页都要用。

export function SettingsSegment<Option extends string>({
  value,
  options,
  onChange
}: {
  value: Option;
  options: ReadonlyArray<{ value: Option; label: string }>;
  onChange: (value: Option) => void;
}) {
  return (
    <div className="settings-segment">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`settings-segment-btn ${value === option.value ? 'active' : ''}`}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
