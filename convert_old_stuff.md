*rolling up sleeves; sterile precision on.* You’ll get a **starter kit** that does four things end-to-end:

1. **Inventory** your old Angular components + real usage (incl. form ties).
2. **Synthesize JSONL mappings** to the new Web Components with **WCAG 2.2 AA** fields.
3. **Generate Angular wrappers + bridges** (CVA + event adapter) where needed.
4. **Guardrails** for safe, non-destructive refactors (codemod dry-run, lint rules, Playwright+axe a11y scan) and **3–5 ADRs**.

Below are drop-in files you can copy into a `tools/` + `libs/` folder in your repo. They’re written to work with Nx, but they’re just Node/TS scripts—run with `ts-node` or compile.

---

# File tree (you create)

```
tools/
  wcmap/
    scan-angular.ts
    scan-wc.ts
    align.ts
    apgPatterns.ts
    gen-wrappers.ts
    gen-jsonl.ts
    codemod.dry-run.ts
  rules/
    no-legacy-after-mapped.ts
    no-fake-e2e.ts
libs/
  wc-bridges/
    src/lib/cva/wc-value-accessor.directive.ts
    src/lib/events/wc-event-adapter.directive.ts
  wrappers/ui/_template/wrapper.template.ts.hbs
  wrappers/ui/app-select.wrapper.ts          // example generated
adr/
  2025-08-27-01-wc-adoption.md
  2025-08-27-02-form-bridge.md
  2025-08-27-03-a11y-aa-baseline.md
  2025-08-27-04-jsonl-mapping-codemods.md
  2025-08-27-05-mf-rollout.md
apps/e2e/a11y/
  app-select.a11y.spec.ts
```

---

# 1) Inventory: old Angular components + usage + form ties

```ts
// tools/wcmap/scan-angular.ts
import { Project, SyntaxKind, Node, Decorator, ts } from 'ts-morph';
import { parseTemplate } from '@angular/compiler';
import * as fs from 'node:fs';
import * as path from 'node:path';

type CompAPI = {
  selector: string;
  file: string;
  inputs: { name: string; type?: string }[];
  outputs: { name: string; type?: string }[];
  methods: string[];
  isCVA: boolean;
};

type Usage = {
  selector: string;
  files: string[];
  counts: {
    total: number;
    withNgModel: number;
    withFormControl: number;
    withFormControlName: number;
    outputs: Record<string, number>;
    inputs: Record<string, number>;
  };
};

const root = process.cwd();
const project = new Project({
  tsConfigFilePath: path.join(root, 'tsconfig.base.json'),
  skipAddingFilesFromTsConfig: false
});

function getDecoratorArgString(dec: Decorator) {
  const call = dec.getCallExpression();
  if (!call) return '';
  const arg = call.getArguments()[0];
  return arg ? arg.getText() : '';
}

function extractSelector(dec: Decorator): string | null {
  const txt = getDecoratorArgString(dec);
  const m = txt.match(/selector\s*:\s*['"`]([^'"`]+)['"`]/);
  return m?.[1] ?? null;
}

function parseInputsOutputs(cls: any) {
  const inputs: any[] = [];
  const outputs: any[] = [];
  for (const prop of cls.getProperties()) {
    for (const d of prop.getDecorators()) {
      const name = d.getName();
      if (name === 'Input') inputs.push({ name: prop.getName(), type: prop.getType().getText() });
      if (name === 'Output') outputs.push({ name: prop.getName(), type: prop.getType().getText() });
    }
  }
  const methods = cls.getMethods().map((m: any) => m.getName());
  const isCVA =
    cls.getImplements().some((i: any) => i.getText().includes('ControlValueAccessor')) ||
    cls.getDecorator('Directive')?.getFullText().includes('NG_VALUE_ACCESSOR') ||
    cls.getDecorator('Component')?.getFullText().includes('NG_VALUE_ACCESSOR');
  return { inputs, outputs, methods, isCVA };
}

function scanComponents(): CompAPI[] {
  const results: CompAPI[] = [];
  for (const sf of project.getSourceFiles('**/*.ts')) {
    for (const cls of sf.getClasses()) {
      const cmp = cls.getDecorator('Component');
      if (!cmp) continue;
      const selector = extractSelector(cmp);
      if (!selector || !selector.includes('-')) continue; // likely Angular comp
      const { inputs, outputs, methods, isCVA } = parseInputsOutputs(cls);
      results.push({
        selector,
        file: sf.getFilePath(),
        inputs,
        outputs,
        methods,
        isCVA
      });
    }
  }
  return results;
}

function scanTemplateUsage(html: string, selectorSet: Set<string>) {
  const ast = parseTemplate(html, 'T', { preserveWhitespaces: false });
  const counts = new Map<string, Usage>();
  function bump(sel: string, kind: keyof Usage['counts'], key?: string) {
    const u = counts.get(sel) ?? {
      selector: sel,
      files: [],
      counts: { total: 0, withNgModel: 0, withFormControl: 0, withFormControlName: 0, outputs: {}, inputs: {} }
    };
    u.counts.total++;
    if (kind === 'inputs' || kind === 'outputs') {
      const bag = u.counts[kind] as Record<string, number>;
      bag[key!] = (bag[key!] ?? 0) + 1;
    } else {
      (u.counts as any)[kind] = (u.counts as any)[kind] + 1;
    }
    counts.set(sel, u);
  }
  for (const n of ast.nodes as any[]) {
    const queue: any[] = [n];
    while (queue.length) {
      const node = queue.shift();
      if (node?.name && selectorSet.has(node.name)) {
        const sel = node.name as string;
        const inputs = (node.inputs ?? []).map((i: any) => i.name);
        const outputs = (node.outputs ?? []).map((o: any) => o.name);
        inputs.forEach((i: string) => bump(sel, 'inputs', i));
        outputs.forEach((o: string) => bump(sel, 'outputs', o));
        // detect forms bindings
        if (inputs.some((i: string) => i === 'ngModel' || i.includes('ngModel'))) bump(sel, 'withNgModel');
        if (inputs.some((i: string) => i === 'formControl')) bump(sel, 'withFormControl');
        if ((node.attributes ?? []).some((a: any) => a.name === 'formControlName')) bump(sel, 'withFormControlName');
      }
      (node.children ?? []).forEach((c: any) => queue.push(c));
    }
  }
  return Array.from(counts.values());
}

function scanUsages(components: CompAPI[]): Usage[] {
  const selectorSet = new Set(components.map(c => c.selector));
  const usagesMap = new Map<string, Usage>();
  const htmlFiles = project.getSourceFiles('**/*.html');
  for (const f of htmlFiles) {
    const text = f.getFullText();
    const local = scanTemplateUsage(text, selectorSet);
    for (const u of local) {
      const acc = usagesMap.get(u.selector) ?? { selector: u.selector, files: [], counts: u.counts };
      acc.files.push(f.getFilePath());
      // merge counts
      const mergeBag = (a: Record<string, number>, b: Record<string, number>) => {
        for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k];
      };
      acc.counts.total += u.counts.total;
      acc.counts.withNgModel += u.counts.withNgModel;
      acc.counts.withFormControl += u.counts.withFormControl;
      acc.counts.withFormControlName += u.counts.withFormControlName;
      mergeBag(acc.counts.inputs, u.counts.inputs);
      mergeBag(acc.counts.outputs, u.counts.outputs);
      usagesMap.set(u.selector, acc);
    }
  }
  return Array.from(usagesMap.values());
}

function main() {
  const comps = scanComponents();
  const usages = scanUsages(comps);
  fs.mkdirSync('dist/wcmap', { recursive: true });
  fs.writeFileSync('dist/wcmap/old-inventory.json', JSON.stringify(comps, null, 2));
  fs.writeFileSync('dist/wcmap/old-usage.json', JSON.stringify(usages, null, 2));
  console.log(`Found ${comps.length} components; wrote dist/wcmap/*`);
}

main();
```

---

# 2) Inventory: new Web Components (from `custom-elements.json` or docs dump)

```ts
// tools/wcmap/scan-wc.ts
import * as fs from 'node:fs';

type WcDecl = {
  tag: string;
  props: string[];
  attrs: string[];
  events: { name: string; detail?: string }[];
  slots: string[];
  methods: string[];
  cssParts: string[];
  cssVars: string[];
};

function fromCustomElementsJson(pathToCEJ: string): WcDecl[] {
  const json = JSON.parse(fs.readFileSync(pathToCEJ, 'utf8'));
  const decls: WcDecl[] = [];
  for (const mod of json.modules ?? []) {
    for (const d of mod.declarations ?? []) {
      if (!d.tagName) continue;
      const tag = d.tagName;
      const attrs = (d.attributes ?? []).map((a: any) => a.name);
      const props = (d.members ?? []).filter((m: any) => m.kind === 'field').map((m: any) => m.name);
      const events = (d.events ?? []).map((e: any) => ({ name: e.name, detail: e.type?.text }));
      const slots = (d.slots ?? []).map((s: any) => s.name || 'default');
      const methods = (d.members ?? []).filter((m: any) => m.kind === 'method').map((m: any) => m.name);
      const cssParts = (d.cssParts ?? []).map((p: any) => p.name);
      const cssVars = (d.cssProperties ?? []).map((p: any) => p.name);
      decls.push({ tag, props, attrs, events, slots, methods, cssParts, cssVars });
    }
  }
  return decls;
}

const cejPath = process.argv[2] || 'custom-elements.json';
const out = fromCustomElementsJson(cejPath);
fs.mkdirSync('dist/wcmap', { recursive: true });
fs.writeFileSync('dist/wcmap/wc-inventory.json', JSON.stringify(out, null, 2));
console.log(`Parsed ${out.length} WC declarations → dist/wcmap/wc-inventory.json`);
```

---

# 3) APG patterns + accessibility defaults (used by the mapper)

```ts
// tools/wcmap/apgPatterns.ts
export type A11ySpec = {
  role: string;
  keyboard: string;         // APG pattern id for your tests
  popup?: { role: string; expandedAttr?: string; controls?: boolean };
  nameAlgo?: 'accname';
  focus?: { visible?: boolean; notObscured?: boolean };
  error?: { ariaInvalid?: boolean; describedBy?: string };
  announcements?: { live?: 'polite' | 'assertive' };
  targetSize?: { minPx: number };
  dragAlt?: boolean;
};

export const DEFAULT_A11Y: Record<string, A11ySpec> = {
  select:   { role: 'combobox', keyboard: 'apg-combobox-listbox', popup: { role: 'listbox', expandedAttr: 'aria-expanded', controls: true }, nameAlgo: 'accname', focus: { visible: true, notObscured: true }, targetSize: { minPx: 24 } },
  combobox: { role: 'combobox', keyboard: 'apg-combobox-listbox', popup: { role: 'listbox', expandedAttr: 'aria-expanded', controls: true }, nameAlgo: 'accname', focus: { visible: true, notObscured: true }, targetSize: { minPx: 24 } },
  dialog:   { role: 'dialog',   keyboard: 'apg-dialog',            focus: { visible: true, notObscured: true } },
  date:     { role: 'combobox', keyboard: 'apg-datepicker-grid',   popup: { role: 'grid', expandedAttr: 'aria-expanded' }, targetSize: { minPx: 24 } },
  input:    { role: 'textbox',  keyboard: 'native-textbox',        targetSize: { minPx: 24 } }
};
```

---

# 4) Mapper: synthesize **AA-aware JSONL** mappings from old+new

```ts
// tools/wcmap/align.ts
import * as fs from 'node:fs';
import { DEFAULT_A11Y } from './apgPatterns';

type OldComp = { selector: string; inputs: {name:string}[]; outputs: {name:string}[]; methods: string[]; isCVA: boolean };
type OldUsage = any;
type WcDecl = { tag: string; props: string[]; attrs: string[]; events: { name: string }[]; slots: string[]; methods: string[] };

function sim(a: string, b: string) {
  const A = a.toLowerCase(), B = b.toLowerCase();
  if (A === B) return 1;
  // cheap token overlap
  const as = new Set(A.split(/[-_:]/)), bs = new Set(B.split(/[-_:]/));
  const inter = Array.from(as).filter(x => bs.has(x)).length;
  return inter / Math.max(as.size, bs.size);
}

function guessKind(sel: string) {
  if (sel.includes('select') || sel.includes('combo')) return 'combobox';
  if (sel.includes('dialog') || sel.includes('modal')) return 'dialog';
  if (sel.includes('date')) return 'date';
  if (sel.includes('input') || sel.includes('text')) return 'input';
  return 'input';
}

function alignOne(oldc: OldComp, wcAll: WcDecl[], usage: any) {
  // pick WC tag
  const tag = wcAll
    .map(w => ({ w, score: Math.max(sim(oldc.selector, w.tag), sim(oldc.selector.replace(/^app-/, ''), w.tag)) }))
    .sort((a, b) => b.score - a.score)[0]?.w;

  if (!tag) return null;

  // inputs mapping by name similarity
  const inputs: Record<string, string> = {};
  for (const i of oldc.inputs) {
    const best = tag.props
      .map(p => ({ p, s: sim(i.name, p) }))
      .sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.5) inputs[i.name] = best.p;
  }

  // outputs mapping by event name similarity
  const outputs: Record<string, { event: string; detail?: string }> = {};
  for (const o of oldc.outputs) {
    const best = tag.events
      .map(e => ({ e, s: sim(o.name.replace(/Change$/, ''), e.name.replace(/-changed$/, '')) }))
      .sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.5) outputs[o.name] = { event: best.e.name, detail: 'detail.value' };
  }

  // two-way: if old had value + valueChange, prefer value-changed
  const hasValue = oldc.inputs.some(i => i.name === 'value');
  const hasValueChange = oldc.outputs.some(o => o.name === 'valueChange' || o.name === 'valueChanged');
  const twoWay = hasValue && hasValueChange
    ? { value: { event: (outputs['valueChange']?.event ?? 'value-changed'), detail: 'detail.value' } }
    : undefined;

  // slots are manual; default stub
  const slots: Record<string, string> = {};

  const kind = guessKind(oldc.selector);
  const a11y = DEFAULT_A11Y[kind];

  return {
    selector: oldc.selector,
    target: tag.tag,
    inputs,
    twoWay,
    outputs,
    slots,
    a11y,
    confidence: Math.round(100 * (Object.keys(inputs).length + Object.keys(outputs).length + (twoWay ? 1 : 0)) / 10) / 100
  };
}

function main() {
  const old = JSON.parse(fs.readFileSync('dist/wcmap/old-inventory.json','utf8')) as OldComp[];
  const usage = JSON.parse(fs.readFileSync('dist/wcmap/old-usage.json','utf8'));
  const wc = JSON.parse(fs.readFileSync('dist/wcmap/wc-inventory.json','utf8')) as WcDecl[];
  fs.mkdirSync('tools/wc/ui-map/shards', { recursive: true });

  for (const oc of old) {
    const m = alignOne(oc, wc, usage.find((u:any)=>u.selector===oc.selector));
    if (!m) continue;
    const line = JSON.stringify({ ...m, verified: false }) + '\n';
    fs.writeFileSync(`tools/wc/ui-map/shards/${oc.selector}.jsonl`, line);
    console.log(`→ shards/${oc.selector}.jsonl`);
  }
}
main();
```

---

# 5) Wrapper generator (Angular → WC, preserves old API)

```ts
// tools/wcmap/gen-wrappers.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

type MapEntry = {
  selector: string;
  target: string;
  inputs: Record<string,string>;
  outputs: Record<string, {event:string; detail?:string}>;
  twoWay?: Record<string,{event:string; detail?:string}>;
};

function pascal(sel: string){ return sel.split('-').map(s=>s[0].toUpperCase()+s.slice(1)).join(''); }

function generateWrapper(me: MapEntry) {
  const className = pascal(me.selector) + 'Wrapper';
  const inputs = Object.keys(me.inputs).map(n => `@Input() ${n}: any;`).join('\n  ');
  const outputs = Object.keys(me.outputs ?? {}).map(n => `@Output() ${n} = new EventEmitter<any>();`).join('\n  ');
  const twoWay = Object.keys(me.twoWay ?? {});
  const templateInputs = Object.entries(me.inputs).map(([oldName, prop]) => `[${prop}]="${oldName}"`).join(' ');
  const eventSpecLines = [
    ...Object.entries(me.outputs ?? {}).map(([ngName, spec]) => `${ngName}: { event: '${spec.event}', detail: '${spec.detail ?? ''}' }`),
    ...twoWay.map(ng => `${ng}Change: { event: '${me.twoWay![ng].event}', detail: '${me.twoWay![ng].detail ?? ''}' }`)
  ];
  return `import { Component, ElementRef, EventEmitter, Input, Output, ViewEncapsulation, NgZone } from '@angular/core';

@Component({
  selector: '${me.selector}',
  template: \`
    <${me.target}
      ${templateInputs}
      [wcEventAdapter]="outputSpec"
      (generic)="route($event)">
      <ng-content></ng-content>
    </${me.target}>
  \`,
  standalone: true,
  encapsulation: ViewEncapsulation.None
})
export class ${className} {
  ${inputs}
  ${outputs}

  outputSpec = { ${eventSpecLines.join(', ')} } as const;

  constructor(private zone: NgZone) {}

  route(e: { name: string; value: any }) {
    const emitter = (this as any)[e.name] as EventEmitter<any>;
    if (emitter?.emit) this.zone.run(() => emitter.emit(e.value));
  }
}
`;
}

function main() {
  const shardsDir = 'tools/wc/ui-map/shards';
  fs.mkdirSync('libs/wrappers/ui', { recursive: true });
  for (const file of fs.readdirSync(shardsDir)) {
    const line = fs.readFileSync(path.join(shardsDir, file), 'utf8').trim();
    if (!line) continue;
    const me = JSON.parse(line) as MapEntry;
    const code = generateWrapper(me);
    const out = `libs/wrappers/ui/${me.selector}.wrapper.ts`;
    fs.writeFileSync(out, code);
    console.log('generated', out);
  }
}
main();
```

**Bridges used by wrappers (drop these in once):**

```ts
// libs/wc-bridges/src/lib/cva/wc-value-accessor.directive.ts
import { Directive, ElementRef, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Directive({
  selector: 'wc-* [formControlName], wc-* [formControl], wc-* [ngModel]',
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => WcValueAccessor), multi: true }]
})
export class WcValueAccessor implements ControlValueAccessor {
  private onChange = (_: any) => {};
  private onTouched = () => {};
  constructor(private host: ElementRef<HTMLElement>) {
    const el: any = host.nativeElement;
    el.addEventListener('change', (e: CustomEvent) => this.onChange((e as any).detail?.value ?? (e.target as any)?.value));
    el.addEventListener('blur', () => this.onTouched());
  }
  writeValue(v: any) { (this.host.nativeElement as any).value = v; }
  registerOnChange(fn: any) { this.onChange = fn; }
  registerOnTouched(fn: any) { this.onTouched = fn; }
  setDisabledState(d: boolean) { (this.host.nativeElement as any).disabled = d; }
}
```

```ts
// libs/wc-bridges/src/lib/events/wc-event-adapter.directive.ts
import { Directive, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output } from '@angular/core';

type OutputSpec = { event: string; detail?: string };

@Directive({ selector: '[wcEventAdapter]' })
export class WcEventAdapter implements OnInit, OnDestroy {
  @Input('wcEventAdapter') spec!: Record<string, OutputSpec>;
  @Output() generic = new EventEmitter<{ name: string; value: any }>();
  private handlers: Array<{ type: string; fn: (e: Event) => void }> = [];
  constructor(private host: ElementRef<HTMLElement>, private zone: NgZone) {}
  ngOnInit() {
    const el = this.host.nativeElement;
    Object.entries(this.spec).forEach(([name, cfg]) => {
      const fn = (evt: Event) => {
        const val = (cfg.detail ?? '').split('.').filter(Boolean).reduce((acc: any, k: string) => acc?.[k], evt as any);
        this.zone.run(() => this.generic.emit({ name, value: val ?? evt }));
      };
      el.addEventListener(cfg.event, fn as any);
      this.handlers.push({ type: cfg.event, fn });
    });
  }
  ngOnDestroy() { const el = this.host.nativeElement; this.handlers.forEach(h => el.removeEventListener(h.type, h.fn)); }
}
```

---

# 6) JSONL writer (makes the **AA** block explicit)

```ts
// tools/wcmap/gen-jsonl.ts
import * as fs from 'node:fs';

const shards = 'tools/wc/ui-map/shards';
for (const f of fs.readdirSync(shards)) {
  const p = `${shards}/${f}`;
  const me = JSON.parse(fs.readFileSync(p,'utf8'));
  if (!me.a11y) {
    me.a11y = { role: 'combobox', keyboard: 'apg-combobox-listbox', popup: { role: 'listbox', expandedAttr: 'aria-expanded', controls: true }, nameAlgo: 'accname', focus: { visible: true, notObscured: true }, targetSize: { minPx: 24 } };
  }
  fs.writeFileSync(p, JSON.stringify(me) + '\n');
  console.log('a11y enriched', f);
}
```

---

# 7) Codemod (non-destructive, **dry-run diffs only**)

```ts
// tools/wcmap/codemod.dry-run.ts
import { parseTemplate, TmplAstTextAttribute, TmplAstBoundAttribute, TmplAstBoundEvent, TmplAstElement } from '@angular/compiler';
import * as fs from 'node:fs';
import * as path from 'node:path';

type MapEntry = { selector: string; target: string; inputs: Record<string,string>; outputs: Record<string,{event:string;detail?:string}>; twoWay?: Record<string,{event:string;detail?:string}>; };
const mapDir = 'tools/wc/ui-map/shards';

function loadMap(): Map<string, MapEntry> {
  const m = new Map<string, MapEntry>();
  for (const f of fs.readdirSync(mapDir)) {
    const line = fs.readFileSync(path.join(mapDir, f),'utf8').trim();
    if (!line) continue;
    const j = JSON.parse(line);
    m.set(j.selector, j);
  }
  return m;
}

function transform(html: string, me: MapEntry) {
  // very conservative: string replace on tag and attribute/event names using the map;
  // leave original as-is if not a safe match. This is fine for dry-run demo.
  let out = html;
  const openTag = new RegExp(`<${me.selector}\\b`,'g');
  out = out.replace(openTag, `<${me.target}`);
  for (const [oldIn, newProp] of Object.entries(me.inputs)) {
    out = out.replace(new RegExp(`\\[${oldIn}\\]=`, 'g'), `[${newProp}]=`);
  }
  for (const [ngName, spec] of Object.entries(me.outputs ?? {})) {
    const ev = spec.event;
    // rewrite (fooChange)="handler($event)" → (ev)="handler($event.detail.value)"
    out = out.replace(new RegExp(`\\(${ngName}\\)=\"([^\"]+)\"`, 'g'), (_m, h) => `(${ev})="${h.replace('$event', spec.detail ?? '$event')}"`);
  }
  // ngModel two-way
  if (me.twoWay?.value) {
    out = out.replace(new RegExp(`\\[\\(value\\)\\]=\"([^\"]+)\"`,'g'),
      (_m, model) => `[${me.inputs['value'] ?? 'value'}]="${model}" (${me.twoWay!.value.event})="${model} = ${me.twoWay!.value.detail ?? '$event'}"`);
  }
  return out;
}

function diff(a: string, b: string) {
  const al = a.split('\n'), bl = b.split('\n');
  const max = Math.max(al.length, bl.length);
  const lines: string[] = [];
  for (let i=0;i<max;i++){
    const L = al[i] ?? '', R = bl[i] ?? '';
    if (L!==R) lines.push(`- ${L}\n+ ${R}`);
  }
  return lines.join('\n');
}

const m = loadMap();
const files = process.argv.slice(2);
for (const f of files) {
  const html = fs.readFileSync(f,'utf8');
  let after = html;
  for (const me of m.values()) {
    if (html.includes(`<${me.selector}`)) after = transform(after, me);
  }
  if (after !== html) {
    console.log(`\n# ${f}\n${diff(html, after)}`);
  }
}
```

> **Guardrail:** this script **never writes**; it prints unified-style hunks. You gate real writes behind human review.

---

# 8) A11y scans (Playwright + axe) for any feature route

```ts
// apps/e2e/a11y/app-select.a11y.spec.ts
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('feature page passes AA checks & keyboard model', async ({ page }) => {
  await page.goto(process.env.APP_URL! + '/feature/countries');

  // Axe scan for common violations
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);

  // Keyboard: open combobox, arrow, enter
  const combo = page.getByTestId('country-select');
  await combo.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');

  // Focus visible & not obscured
  const active = await page.evaluate(() => document.activeElement?.getBoundingClientRect());
  expect(active?.width).toBeGreaterThan(0);
  expect(active?.height).toBeGreaterThan(0);
});
```

---

# 9) Lint guardrails (custom ESLint rules)

```ts
// tools/rules/no-legacy-after-mapped.ts
import { TSESLint, TSESTree } from '@typescript-eslint/utils';
import * as fs from 'node:fs';

const m: Record<string, true> = {};
try {
  for (const f of fs.readdirSync('tools/wc/ui-map/shards')) {
    const line = fs.readFileSync(`tools/wc/ui-map/shards/${f}`,'utf8').trim();
    if (!line) continue;
    const j = JSON.parse(line);
    m[j.selector] = true;
  }
} catch {}

const rule: TSESLint.RuleModule<'legacy', []> = {
  meta: { type: 'problem', messages: { legacy: 'Legacy selector "{{name}}" is mapped—use wrapper or WC instead.' } },
  create(ctx) {
    return {
      'Literal[value]'(node: any) {
        const v = node.value as string;
        if (typeof v === 'string' && v.startsWith('<')) {
          Object.keys(m).forEach(sel => {
            if (v.includes(`<${sel}`)) ctx.report({ node: node as any, messageId: 'legacy', data: { name: sel } });
          });
        }
      }
    };
  }
};
export = rule;
```

```ts
// tools/rules/no-fake-e2e.ts
import { TSESLint } from '@typescript-eslint/utils';
const rule: TSESLint.RuleModule<'fake', []> = {
  meta: { type: 'problem', messages: { fake: 'Tests tagged @e2e cannot use network interception.' } },
  create(ctx) {
    const filename = ctx.getFilename();
    const isE2E = /e2e/.test(filename);
    return isE2E ? {
      CallExpression(node) {
        const text = ctx.getSourceCode().getText(node);
        if (/cy\.intercept|page\.route\(/.test(text)) ctx.report({ node: node as any, messageId: 'fake' });
      }
    } : {};
  }
};
export = rule;
```

Wire these in `.eslintrc.cjs` as a plugin or via `overrides` for `*.html`/`*.ts`.

---

# 10) **Guardrails prompt** for GPT-5-mini (paste this when you use it)

```
SYSTEM: You are a refactor bot operating under strict guardrails. You MUST:
- Read a single JSONL shard that maps an old Angular component to a new Web Component, including inputs, outputs, twoWay, and a11y.
- Generate ONLY the requested artifact (wrapper | CVA | event adapter | codemod patch) and nothing else.
- Be non-destructive: never delete logic; add wrappers instead; produce diffs for templates.
- Respect WCAG 2.2 AA: ensure roles/aria attributes per shard.a11y; compose & bubble events; maintain focus visibility.
- Never invent unmapped API names. If missing, output a TODO.

USER INPUT INCLUDES:
1) The JSONL shard.
2) One or more specific files to change.
3) The requested artifact type.

OUTPUT FORMAT:
- For code: a single file with exact path + contents.
- For diffs: unified diff with file headers; no side chatter.
- Include TODOs when mapping confidence < 0.7 or structural directives are present.
```

---

# 11) ADRs (short, concrete—drop in `adr/`)

**01 – Web Components Adoption via Angular Wrappers**

* **Decision:** Adopt WC as UI substrate; ship Angular wrappers to preserve old API during transition.
* **Why:** Reduce framework lock-in, enable MF-safe remote reuse, align with design system.
* **Constraints:** No network mocks in E2E; mapping lives in JSONL; wrappers must honor CVA + a11y.
* **Consequences:** Temporary duplication; small perf cost for wrapper; large test gains.

**02 – Form Control Bridge (CVA)**

* **Decision:** Single generic CVA directive for `wc-*` elements, parameterized by JSONL `twoWay`.
* **Why:** Preserve reactive forms semantics (dirty/touched/status).
* **Constraints:** Events must be `{bubbles:true, composed:true}`; Zone re-entry via `NgZone.run`.
* **Consequences:** Predictable forms; minimal per-component code.

**03 – Accessibility Baseline (WCAG 2.2 AA)**

* **Decision:** Enforce AA per APG patterns in JSONL `a11y`; CI gates via Playwright+axe + keyboard scripts.
* **Why:** Legal & usability baseline; “A” is insufficient.
* **Constraints:** Focus not obscured; target size ≥24px; dragging has alternatives.
* **Consequences:** Some WC require wrapper-added ARIA.

**04 – Mapping Registry & Codemods**

* **Decision:** Sharded JSONL (`tools/wc/ui-map/shards/*.jsonl`) is the **single source of truth**; codemods consume it in **dry-run**; humans review diffs.
* **Why:** Determinism, auditability, and safe rollout.
* **Constraints:** Confidence <0.7 → human required; no writes in CI.
* **Consequences:** Slower per-component start; safer scale-out.

**05 – Module Federation Rollout**

* **Decision:** Per-remote flag `USE_WC`; wrappers ship first; host flips after parity.
* **Why:** Avoid breaking host during remote upgrades.
* **Constraints:** Public API surfaces unchanged across remotes until flip.
* **Consequences:** Dual paths briefly; clear cutover plan.

---

# 12) What to run (order of ops)

```bash
# 1) Inventory
ts-node tools/wcmap/scan-angular.ts
ts-node tools/wcmap/scan-wc.ts ./path/to/custom-elements.json

# 2) Align & emit JSONL shards
ts-node tools/wcmap/align.ts
ts-node tools/wcmap/gen-jsonl.ts   # add a11y block defaults

# 3) Generate wrappers (for mapped comps)
ts-node tools/wcmap/gen-wrappers.ts

# 4) Dry-run codemods on a target feature
ts-node tools/wcmap/codemod.dry-run.ts apps/feature/**/**.html

# 5) Run a11y smoke on the feature route
APP_URL=https://localhost:4200 npx playwright test apps/e2e/a11y/app-select.a11y.spec.ts
```

---

## Bottom line

This gives you **real scripts and guardrails** you can paste into a scratch repo tonight, then into work. Start with one component (your “select/combobox”), run the inventory → mapping → wrapper → dry-run → a11y test loop, and you’ll have a credible Friday demo plus the scaffolding to scale.
