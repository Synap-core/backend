Legacy single-quoted props with an apostrophe in the value are NOT a directive in micromark:

:::synap-cell{cellKey="chart-pie" cellProps='{"label":"Team's load"}'}
:::

A double-quoted value may hold an apostrophe:

:::synap-entity{id="o'brien-1"}
:::

A single-quoted value may hold a double quote and braces:

:::synap-cell{cellKey="chart-bar" cellProps='{"label":"The \"load\" {x}"}'}
:::

The new grammar carries apostrophes safely in the props block:

:::synap-cell{cellKey="chart-bar"}
```json
{"profileSlug":"task","label":"The team's \"load\" {x}","note":":::"}
```

**Tasks by status**: 3 open, 2 done — it's Review.
:::
