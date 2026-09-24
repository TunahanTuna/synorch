# 04-tool-heavy: Tool-heavy turn (~20 tools)

## 80x24

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 2 · bytes written: 12276

### turn done (viewport)

```text

> audit the project and fix add

✓ Read 8 files  README.md, package.json, +6
✓ Search "export" in src  6 matches in 6 files
✓ Search "add\("  2 matches in 2 files
✓ List src  6 entries
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new, and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%                       ? shortcuts
```

### turn done (full scrollback)

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> audit the project and fix add

✓ Read 8 files  README.md, package.json, +6
✓ Search "export" in src  6 matches in 6 files
✓ Search "add\("  2 matches in 2 files
✓ List src  6 entries
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new, and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%                       ? shortcuts
```

### ctrl+o expanded (viewport)

```text
      export const f = 6;

✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
      ✔ add (0.5852ms)
      ℹ tests 1
      ℹ suites 0
      ℹ pass 1
      ℹ fail 0
      ℹ cancelled 0
      ℹ skipped 0
      ℹ todo 0
      ℹ duration_ms 74.4148
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new, and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%                       ? shortcuts
```

## 120x40

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 2 · bytes written: 15475

### turn done (viewport)

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> audit the project and fix add

✓ Read 8 files  README.md, package.json, +6
✓ Search "export" in src  6 matches in 6 files
✓ Search "add\("  2 matches in 2 files
✓ List src  6 entries
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new, and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%                                                               ? shortcuts














```

### turn done (full scrollback)

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> audit the project and fix add

✓ Read 8 files  README.md, package.json, +6
✓ Search "export" in src  6 matches in 6 files
✓ Search "add\("  2 matches in 2 files
✓ List src  6 entries
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new, and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%                                                               ? shortcuts
```

### ctrl+o expanded (viewport)

```text
      src/d.mjs:1:export const d = 4;
      src/e.mjs:1:export const e = 5;
✓ Search "add\("  2 matches in 2 files
      add.test.mjs:5:test("add", () => assert.equal(add(2, 3), 5));
      src/add.mjs:1:export function add(a, b) {
✓ List src  6 entries
      src/a.mjs
      src/add.mjs
      src/b.mjs
      src/c.mjs
      src/d.mjs
      src/e.mjs
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
      export const f = 6;

✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
      ✔ add (0.5563ms)
      ℹ tests 1
      ℹ suites 0
      ℹ pass 1
      ℹ fail 0
      ℹ cancelled 0
      ℹ skipped 0
      ℹ todo 0
      ℹ duration_ms 69.8327
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new, and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%                                                               ? shortcuts
```

## 40x20

- enter -> user line: 3 ms · enter -> activity: 3 ms · full redraws (screen+scrollback clears): 2 · bytes written: 10611

### turn done (viewport)

```text
✓ List src  6 entries
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new,
  and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1
  passed · /diff for details
────────────────────────────────────────
>  Ask anything or describe a change ·…
────────────────────────────────────────
  ws · sol-large · auto mode · ctx 2%
```

### turn done (full scrollback)

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow
can write outside this folder

> audit the project and fix add

✓ Read 8 files
  ⎿ README.md, package.json, +6
✓ Search "export" in src
  ⎿ 6 matches in 6 files
✓ Search "add\("  2 matches in 2 files
✓ List src  6 entries
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Write src/f.mjs  new file · 1 line
✓ Read 3 files  a.mjs, b.mjs, +1
✓ Run node --test  1 passed · 0.1s
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new,
  and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1
  passed · /diff for details
────────────────────────────────────────
>  Ask anything or describe a change ·…
────────────────────────────────────────
  ws · sol-large · auto mode · ctx 2%
```

### ctrl+o expanded (viewport)

```text
      ℹ suites 0
      ℹ pass 1
      ℹ fail 0
      ℹ cancelled 0
      ℹ skipped 0
      ℹ todo 0
      ℹ duration_ms 73.7599
✓ Search "zzz-nothing"  no matches
✗ Read missing.mjs
  ⎿ file not found

● Done. add is fixed, src/f.mjs is new,
  and the test suite passes.

✓ Changed 2 files (+2 −1) · Tests: 1
  passed · /diff for details
────────────────────────────────────────
>  Ask anything or describe a change ·…
────────────────────────────────────────
  ws · sol-large · auto mode · ctx 2%
```
