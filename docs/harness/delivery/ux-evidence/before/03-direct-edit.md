# 03-direct-edit: Direct edit with diff

## 80x24

- enter -> user line: 1 ms · enter -> activity: 34 ms · full redraws (screen+scrollback clears): 0 · bytes written: 7653

### turn done

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.2s

● Fixed: add subtracted instead of adding. The test passes now.
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%



```

### /diff

```text
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.2s

● Fixed: add subtracted instead of adding. The test passes now.

> /diff
Changed by Synorch (not independently reviewed):
src/add.mjs
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%
```

## 120x40

- enter -> user line: 2 ms · enter -> activity: 36 ms · full redraws (screen+scrollback clears): 0 · bytes written: 9580

### turn done

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Fixed: add subtracted instead of adding. The test passes now.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%



















```

### /diff

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Fixed: add subtracted instead of adding. The test passes now.

> /diff
Changed by Synorch (not independently reviewed):
src/add.mjs
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%















```

## 40x20

- enter -> user line: 1 ms · enter -> activity: 21 ms · full redraws (screen+scrollback clears): 0 · bytes written: 6082

### turn done

```text

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Fixed: add subtracted instead of
  adding. The test passes now.
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · auto mode...


```

### /diff

```text

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;

● Run node --test
  ⎿ ✓ exit 0 · 1 passed · 0.1s

● Fixed: add subtracted instead of
  adding. The test passes now.

> /diff
Changed by Synorch (not independently
reviewed):
src/add.mjs
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · auto mode...
```
