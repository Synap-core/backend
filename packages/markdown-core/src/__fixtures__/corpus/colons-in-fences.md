A fence at the root hides every directive line inside it:

```md
:::synap-entity{id="not-an-embed"}
:::
```

~~~
::::synap-section{id="also-not"}
~~~

Inside a container, a fence hides OPENERS but not the container's own closer:

::::synap-section{id="s1"}
## Fenced example

```md
:::synap-cell{cellKey="hidden-in-code"}
:::
```

A three-colon line inside a fence cannot close a four-colon section:

```
:::
```
::::

:::synap-cell{cellKey="closes-inside-fence"}
```json
{"a":1}
:::
after the implicit close
