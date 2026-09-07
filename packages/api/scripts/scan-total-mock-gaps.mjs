// Census of the total-`vi.mock` trap in `packages/api`.
//
// `vi.mock(spec, () => ({...}))` is a TOTAL replacement: the factory must list
// EVERY export the module-under-test imports from `spec`. When source later
// gains a new import, every test in that file dies — often as a suite that
// collects ZERO tests, which no typecheck can see.
//
// This reports the real denominator rather than the files that happen to be
// failing today: total-replacement factories, and which of them are already
// statically missing a name the module-under-test imports. A "latent" entry
// passes right now and detonates on the next unrelated source change.
//
// Measured 2026-09-06: 667 factories, 510 total-replacement, 40 missing a
// name, 5 failing, 35 latent. `__tripwires__/database-mock-total-ratchet`
// guards only the `@synap/database` subset (65 files) — most latent sites sit
// in modules no ratchet watches.
//
// Usage: node scripts/scan-total-mock-gaps.mjs
import fs from "fs"; import path from "path";
const API = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "src");
function walk(d, out=[]) { for (const e of fs.readdirSync(d,{withFileTypes:true})) { const p=path.join(d,e.name); if (e.isDirectory()) walk(p,out); else if (e.name.endsWith(".ts")) out.push(p); } return out; }
function scanTotalMockGaps() {
const all = walk(API);
const tests = all.filter(f=>f.endsWith(".test.ts"));

function matchParen(src, i) { // i at '('
  let d=0;
  for (let j=i;j<src.length;j++){ const c=src[j];
    if (c==='"'||c==="'"||c==='`'){ const q=c; j++; while(j<src.length && src[j]!==q){ if(src[j]==='\\')j++; j++; } continue; }
    if (c==='(')d++; else if(c===')'){d--; if(d===0) return j;} }
  return -1;
}
// extract object keys at brace-depth 1 inside a factory body
function factoryKeys(body){
  const keys=new Set(); let d=0;
  const re=/[{}]|(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(:|,|\})/g;
  // simpler: scan chars tracking brace depth, collect identifiers preceded by { or , at depth 1
  let i=0, depth=0;
  while(i<body.length){
    const c=body[i];
    if(c==='"'||c==="'"||c==='`'){ const q=c;i++; while(i<body.length&&body[i]!==q){if(body[i]==='\\')i++;i++;} i++; continue;}
    if(c==='{'){depth++;i++;continue;}
    if(c==='}'){depth--;i++;continue;}
    if(depth===1 && /[A-Za-z_$]/.test(c)){
      // must be preceded by { , or start
      let k=i-1; while(k>=0 && /\s/.test(body[k]))k--;
      if(k<0 || body[k]==='{' || body[k]===','){
        let j=i; while(j<body.length && /[\w$]/.test(body[j]))j++;
        let n=j; while(n<body.length && /\s/.test(body[n]))n++;
        if(body[n]===':'||body[n]===','||body[n]==='}') keys.add(body.slice(i,j));
        i=j; continue;
      }
    }
    i++;
  }
  return keys;
}
function resolveRel(fromFile, spec){
  if(!spec.startsWith(".")) return null;
  let p = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/,"");
  for (const cand of [p+".ts", path.join(p,"index.ts")]) if (fs.existsSync(cand)) return cand;
  return null;
}
// named imports of `spec` inside file
function namedImportsOf(file, spec){
  const src=fs.readFileSync(file,"utf8");
  const out=new Set();
  const re=new RegExp('import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["\']'+spec.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'["\']','g');
  let m; while((m=re.exec(src))){
    if(m[1]) continue; // type-only import: erased, harmless
    for (let part of m[2].split(",")){
      part=part.trim(); if(!part) continue;
      if(/^type\s/.test(part)) continue;
      const name=part.split(/\s+as\s+/)[0].trim();
      if(name) out.add(name);
    }
  }
  return out;
}
const findings=[];
let totalFactories=0;
for (const t of tests){
  const src=fs.readFileSync(t,"utf8");
  // relative modules the test imports (candidate modules-under-test)
  const deps=new Set();
  for (const m of src.matchAll(/from\s*["'](\.[^"']+)["']/g)) { const r=resolveRel(t,m[1]); if(r) deps.add(r); }
  for (const m of src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) { const r=resolveRel(t,m[1]); if(r) deps.add(r); }
  const mockRe=/vi\.mock\(\s*["']([^"']+)["']\s*,/g; let mm;
  while((mm=mockRe.exec(src))){
    const spec=mm[1];
    const open=src.indexOf("(",mm.index);
    const close=matchParen(src,open); if(close<0) continue;
    const call=src.slice(open,close+1);
    totalFactories++;
    if(/importOriginal|importActual/.test(call)) continue;
    let body=call.slice(call.indexOf(","));
    // block-bodied factory: () => { ... return { ... } }  -> use the returned object
    const rIdx=body.search(/return\s*\{/);
    if(/=>\s*\{/.test(body) && !/=>\s*\(\s*\{/.test(body) && rIdx>=0) body=body.slice(body.indexOf("{", rIdx));
    const hasSpread=/\.\.\./.test(body);
    const keys=factoryKeys(body);
    // which mocked deps import missing names?
    for (const dep of deps){
      if (dep===t) continue;
      const used=namedImportsOf(dep, spec);
      const missing=[...used].filter(n=>!keys.has(n));
      if(missing.length && !hasSpread) findings.push({test:path.relative(API,t), spec, dep:path.relative(API,dep), missing});
    }
  }
}
  return { totalFactories, findings };
}

// Importable for `__tripwires__/total-mock-missing-export-ratchet.test.ts`.
export { scanTotalMockGaps };

// CLI: `node scripts/scan-total-mock-gaps.mjs`
if (process.argv[1] && process.argv[1].endsWith("scan-total-mock-gaps.mjs")) {
  const { totalFactories, findings } = scanTotalMockGaps();
  console.log("factories scanned:", totalFactories);
  console.log(
    "FINDINGS (total-replacement mock missing a name the module-under-test imports):",
    findings.length
  );
  for (const f of findings)
    console.log(` ${f.test}\n    mock ${f.spec}  <- ${f.dep} needs [${f.missing.join(", ")}]`);
}
