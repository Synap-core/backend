A `$$` math block hides every directive line inside it, like a code fence:

$$
:::synap-entity{id="not-an-embed"}
:::
$$

A longer opener needs a closer at least as long:

$$$
x = 1
$$
:::synap-view{viewId="still-math"}
$$$

`$$E = mc^2$$` on one line is inline math in a paragraph, never a fence, so the
embed after it is real:

$$E = mc^2$$

:::synap-entity{id="after-inline-display"}
:::

Inside a section, a math block hides OPENERS but not the section's own closer:

::::synap-section{id="m1"}
## Maths

$$
:::synap-cell{cellKey="hidden-in-math"}
$$

Prices stay prose: it costs $5 and $10, or US$5 each.
::::
