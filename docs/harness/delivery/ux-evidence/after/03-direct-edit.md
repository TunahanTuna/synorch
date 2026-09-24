# 03-direct-edit: Direct edit with diff

## 80x24

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 0 · bytes written: 7318

### turn done

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Run node --test  1 passed · 0.2s

● Fixed: add subtracted instead of adding. The test passes now.

✓ Changed src/add.mjs (+1 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%                       ? shortcuts






```

### /diff

```text
✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Run node --test  1 passed · 0.2s

● Fixed: add subtracted instead of adding. The test passes now.

✓ Changed src/add.mjs (+1 −1) · Tests: 1 passed · /diff for details

> /diff

1 file changed by Synorch  +1 −1
not independently reviewed · /undo reverts the last edit

● src/add.mjs  +1 −1
   1   export function add(a, b) {
   2 −   return a - b;
   2 +   return a + b;
   3   }
────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%                       ? shortcuts
```

## 120x40

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 0 · bytes written: 8502

### turn done

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Run node --test  1 passed · 0.1s

● Fixed: add subtracted instead of adding. The test passes now.

✓ Changed src/add.mjs (+1 −1) · Tests: 1 passed · /diff for details
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%                                                               ? shortcuts






















```

### /diff

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix the add function

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Run node --test  1 passed · 0.1s

● Fixed: add subtracted instead of adding. The test passes now.

✓ Changed src/add.mjs (+1 −1) · Tests: 1 passed · /diff for details

> /diff

1 file changed by Synorch  +1 −1
not independently reviewed · /undo reverts the last edit

● src/add.mjs  +1 −1
   1   export function add(a, b) {
   2 −   return a - b;
   2 +   return a + b;
   3   }
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%                                                               ? shortcuts











```

## 40x20

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 0 · bytes written: 5642

### turn done

```text
! Sandbox is partial: commands you allow
can write outside this folder

> fix the add function

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;
✓ Run node --test  1 passed · 0.1s

● Fixed: add subtracted instead of
  adding. The test passes now.

✓ Changed src/add.mjs (+1 −1) · Tests: 1
  passed · /diff for details
────────────────────────────────────────
>  Ask anything or describe a change ·…
────────────────────────────────────────
  ws · sol-large · auto mode · ctx 1%
```

### /diff

```text
● Fixed: add subtracted instead of
  adding. The test passes now.

✓ Changed src/add.mjs (+1 −1) · Tests: 1
  passed · /diff for details

> /diff

1 file changed by Synorch  +1 −1
not independently reviewed · /undo reve…

● src/add.mjs  +1 −1
   1   export function add(a, b) {
   2 −   return a - b;
   2 +   return a + b;
   3   }
────────────────────────────────────────
>  Ask anything or describe a change ·…
────────────────────────────────────────
  ws · sol-large · auto mode · ctx 1%
```
