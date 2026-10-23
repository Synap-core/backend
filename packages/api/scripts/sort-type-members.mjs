import ts from "typescript";

/**
 * Sort the property members of every object type literal (gen-types
 * post-process), at any depth. dts-bundle-generator prints an INFERRED object
 * type's members in the order the checker happened to create them, which
 * depends on the upstream dists: on 2026-10-21 a fresh CI build printed
 * `workspaces.list`'s `archivedAt` after `settings` while the committed file
 * held it last, from the same source, and gen-types:check failed. Member order
 * is meaningless in an object type, so this changes no type — it only makes
 * the printed file independent of how it was built (like
 * sort-literal-unions.mjs does for literal unions).
 *
 * A literal is left as printed when it holds anything but property signatures
 * (call, construct, index or method signatures — overload order matters), when
 * two members share a name, or when a member does not end in `;` (moving it
 * would glue it to its neighbour). A member's leading comments travel with it.
 */
export function sortTypeLiteralMembers(text) {
  const sf = ts.createSourceFile(
    "generated.d.ts",
    text,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );

  const children = (node) => {
    const kids = [];
    node.forEachChild((c) => {
      kids.push(c);
    });
    return kids;
  };

  const memberName = (m) =>
    m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
      ? m.name.text
      : null;

  const sortable = (node, kids) => {
    if (!ts.isTypeLiteralNode(node) || kids.length < 2) return false;
    const names = new Set();
    for (let i = 0; i < kids.length; i++) {
      const m = kids[i];
      if (!ts.isPropertySignature(m)) return false;
      const name = memberName(m);
      if (name === null || names.has(name)) return false;
      names.add(name);
      if (!text.slice(m.pos, m.end).trimEnd().endsWith(";")) return false;
      if (i > 0 && kids[i - 1].end !== m.pos) return false;
    }
    return true;
  };

  const emit = (node) => {
    const kids = children(node);
    if (kids.length === 0) return text.slice(node.pos, node.end);
    const order = sortable(node, kids)
      ? [...kids].sort((a, b) => {
          const x = memberName(a);
          const y = memberName(b);
          return x < y ? -1 : x > y ? 1 : 0;
        })
      : kids;
    let out = text.slice(node.pos, kids[0].pos);
    order.forEach((k, i) => {
      out += emit(k);
      // Gaps are taken from the ORIGINAL positions, so punctuation between
      // children (and, in a sorted literal, the empty gap between members)
      // stays where it was.
      const next = kids[i + 1];
      out += text.slice(kids[i].end, next ? next.pos : node.end);
    });
    return out;
  };

  return emit(sf);
}
