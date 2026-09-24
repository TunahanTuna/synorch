# 04-tool-heavy: Tool-heavy turn (~20 tools)

## 80x24

- enter -> user line: 1 ms · enter -> activity: 18 ms · full redraws (screen+scrollback clears): 2 · bytes written: 14811

### turn done (viewport)

```text
     +   return a + b;

● Write src/f.mjs
  ⎿ new file · 1 lines

● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory, stat 'C:\Users\tuna\AppData\Local\Temp...

● Done. add is fixed, src/f.mjs is new, and the test suite passes.
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%


```

### turn done (full scrollback)

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> audit the project and fix add

● Read 8 files
  ⎿ README.md, package.json, +6

● Search "export" in src
  ⎿ 6 matches in 6 files

● Search "add\("
  ⎿ 2 matches in 2 files

● List src
  ⎿ 6 entries

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Write src/f.mjs
  ⎿ new file · 1 lines

● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory, stat 'C:\Users\tuna\AppData\Local\Temp...

● Done. add is fixed, src/f.mjs is new, and the test suite passes.
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%
```

### ctrl+o expanded (viewport)

```text

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s
     ✔ add (0.561ms)
     ℹ tests 1
     ℹ suites 0
     ℹ pass 1
     ℹ fail 0
     ℹ cancelled 0
     ℹ skipped 0
     ℹ todo 0
     ℹ duration_ms 69.7986

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory, stat 'C:\Users\tuna\AppData\Local\Temp...

● Done. add is fixed, src/f.mjs is new, and the test suite passes.
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%
```

## 120x40

- enter -> user line: 1 ms · enter -> activity: 34 ms · full redraws (screen+scrollback clears): 2 · bytes written: 16616

### turn done (viewport)

```text

● Read 8 files
  ⎿ README.md, package.json, +6

● Search "export" in src
  ⎿ 6 matches in 6 files

● Search "add\("
  ⎿ 2 matches in 2 files

● List src
  ⎿ 6 entries

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Write src/f.mjs
  ⎿ new file · 1 lines

● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory, stat 'C:\Users\tuna\AppData\Local\Temp\syn-e2e-hFyQiR\ws\missing.mjs'

● Done. add is fixed, src/f.mjs is new, and the test suite passes.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%


```

### turn done (full scrollback)

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> audit the project and fix add

● Read 8 files
  ⎿ README.md, package.json, +6

● Search "export" in src
  ⎿ 6 matches in 6 files

● Search "add\("
  ⎿ 2 matches in 2 files

● List src
  ⎿ 6 entries

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Write src/f.mjs
  ⎿ new file · 1 lines

● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory, stat 'C:\Users\tuna\AppData\Local\Temp\syn-e2e-hFyQiR\ws\missing.mjs'

● Done. add is fixed, src/f.mjs is new, and the test suite passes.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%
```

### ctrl+o expanded (viewport)

```text
     src/c.mjs
     src/d.mjs
     src/e.mjs

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Write src/f.mjs
  ⎿ new file · 1 lines
     export const f = 6;


● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s
     ✔ add (0.5515ms)
     ℹ tests 1
     ℹ suites 0
     ℹ pass 1
     ℹ fail 0
     ℹ cancelled 0
     ℹ skipped 0
     ℹ todo 0
     ℹ duration_ms 70.4387

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory, stat 'C:\Users\tuna\AppData\Local\Temp\syn-e2e-hFyQiR\ws\missing.mjs'

● Done. add is fixed, src/f.mjs is new, and the test suite passes.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 2%
```

## 40x20

- enter -> user line: 1 ms · enter -> activity: 32 ms · full redraws (screen+scrollback clears): 2 · bytes written: 11867

### turn done (viewport)

```text
● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory...

● Done. add is fixed, src/f.mjs is new,
  and the test suite passes.
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · auto mode...


```

### turn done (full scrollback)

```text
Synorch 0.3.0 · ws (master) · sol-large
· autonomous
! Sandbox is partial: commands you allow
can write outside this folder

> audit the project and fix add

● Read 8 files
  ⎿ README.md, package.json, +6

● Search "export" in src
  ⎿ 6 matches in 6 files

● Search "add\("
  ⎿ 2 matches in 2 files

● List src
  ⎿ 6 entries

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Write src/f.mjs
  ⎿ new file · 1 lines

● Read 3 files
  ⎿ a.mjs, b.mjs, +1

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory...

● Done. add is fixed, src/f.mjs is new,
  and the test suite passes.
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · auto mode...
```

### ctrl+o expanded (viewport)

```text
     ℹ suites 0
     ℹ pass 1
     ℹ fail 0
     ℹ cancelled 0
     ℹ skipped 0
     ℹ todo 0
     ℹ duration_ms 71.0024

● Search "zzz-nothing"
  ⎿ no matches

● Read missing.mjs
  ⎿ ENOENT: no such file or directory...

● Done. add is fixed, src/f.mjs is new,
  and the test suite passes.
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · auto mode...
```
