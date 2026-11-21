$files = 'modeller.html', 'dashboard.html'

$tokens = @'
:root {
  --bg: #fafaf8; --surface: #ffffff; --surface-warm: #f3e6d7;
  --fg: #33261c; --muted: #96826f; --line: #efe1cf; --line-strong: #d9bfa4;
  --accent: #a0702c; --accent-strong: #7a5322; --accent-soft: #f3e6d7;
}
'@

$map = [ordered]@{
  '#fffaf3' = 'var(--surface)'
  '#ffffff' = 'var(--surface)'
  '#fff'    = 'var(--surface)'
  '#faf3ea' = 'var(--bg)'
  '#faf3e6' = 'var(--bg)'
  '#fbf3e6' = 'var(--bg)'
  '#fbf7ee' = 'var(--bg)'
  '#f8efe2' = 'var(--surface-warm)'
  '#f8f1e4' = 'var(--surface-warm)'
  '#f3ede0' = 'var(--surface-warm)'
  '#fdf0e2' = 'var(--surface-warm)'
  '#f6ede0' = 'var(--surface-warm)'
  '#f0e8d8' = 'var(--surface-warm)'
  '#f3e8d8' = 'var(--accent-soft)'
  '#fdece0' = 'var(--accent-soft)'
  '#fce6d2' = 'var(--accent-soft)'
  '#f7dcc8' = 'var(--accent-soft)'
  '#e0b98a' = 'var(--accent-soft)'
  '#e3d3ba' = 'var(--line)'
  '#e6dcc9' = 'var(--line)'
  '#e9dcc5' = 'var(--line)'
  '#ece0cc' = 'var(--line)'
  '#ddd0ba' = 'var(--line)'
  '#e6e0d4' = 'var(--line)'
  '#d5c5a8' = 'var(--line-strong)'
  '#c9b998' = 'var(--line-strong)'
  '#e8c496' = 'var(--line-strong)'
  '#3a3126' = 'var(--fg)'
  '#55503f' = 'var(--fg)'
  '#a4977f' = 'var(--muted)'
  '#8a7d68' = 'var(--muted)'
  '#7a6d58' = 'var(--muted)'
  '#6b6560' = 'var(--muted)'
  '#b5a68d' = 'var(--muted)'
  '#c3b69c' = 'var(--muted)'
  '#d97742' = 'var(--accent)'
  '#b5601f' = 'var(--accent-strong)'
  '#b5502f' = 'var(--accent-strong)'
  '#96551f' = 'var(--accent-strong)'
}

foreach ($f in $files) {
  $c = Get-Content $f -Raw
  $rx = [regex]::new('<style>')
  if (-not $c.Contains(':root { --bg: #fafaf8')) {
    $c = $rx.Replace($c, "<style>`n  $tokens", 1)
  }
  foreach ($k in $map.Keys) { $c = $c -replace [regex]::Escape($k), $map[$k] }
  Set-Content $f $c -NoNewline -Encoding UTF8
  Write-Host "migrated $f"
}