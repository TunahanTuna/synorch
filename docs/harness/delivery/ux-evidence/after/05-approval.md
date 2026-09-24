# 05-approval: Approval prompt (ask mode)

## 80x24

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 0 · bytes written: 5254

### approval prompt

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix add

✓ Read src/add.mjs  3 lines
● Edit src/add.mjs

? Waiting for you… · 0s · 160 tokens

────────────────────────────────────────────────────────────────────────────────
 Allow Synorch to edit files?
   Edit src/add.mjs  +1 −1
     −   return a - b;
     +   return a + b;
   changes files in the workspace (/undo reverts Synorch's edits)
 → 1. Allow once
   2. Allow all edits (switch to auto mode)
   3. Deny
   4. Deny and tell Synorch why
   1-4 or ↑↓ + Enter · Esc denies
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · approval waiting · ctx 1%     ? shortcuts

```

### after approving

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix add

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;

● Fixed the subtraction.

! Changed src/add.mjs (+1 −1) · Tests: not run · /diff for details
────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · ctx 1%                        ? shortcuts







```

## 120x40

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 0 · bytes written: 7175

### approval prompt

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix add

✓ Read src/add.mjs  3 lines
● Edit src/add.mjs

? Waiting for you… · 0s · 160 tokens

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Allow Synorch to edit files?
   Edit src/add.mjs  +1 −1
     −   return a - b;
     +   return a + b;
   changes files in the workspace (/undo reverts Synorch's edits)
 → 1. Allow once
   2. Allow all edits (switch to auto mode)
   3. Deny
   4. Deny and tell Synorch why
   1-4 or ↑↓ + Enter · Esc denies
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · approval waiting · ctx 1%                                             ? shortcuts

















```

### after approving

```text
Synorch 0.3.0 · ws (master)
! Sandbox is partial: commands you allow can write outside this folder

> fix add

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;

● Fixed the subtraction.

! Changed src/add.mjs (+1 −1) · Tests: not run · /diff for details
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
>  Ask anything or describe a change · / commands · @ files
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · ctx 1%                                                                ? shortcuts























```

## 40x20

- enter -> user line: 1 ms · enter -> activity: 1 ms · full redraws (screen+scrollback clears): 0 · bytes written: 3533

### approval prompt

```text

✓ Read src/add.mjs  3 lines
● Edit src/add.mjs

? Waiting for you… · 0s · 160 tokens

────────────────────────────────────────
 Allow Synorch to edit files?
   Edit src/add.mjs  +1 −1
     −   return a - b;
     +   return a + b;
   changes files in the workspace
 (/undo reverts Synorch's edits)
 → 1. Allow once
   2. Allow all edits (switch to auto
   3. Deny
   4. Deny and tell Synorch why
   1-4 or ↑↓ + Enter · Esc denies
────────────────────────────────────────
  ask mode · approval waiting · ctx 1%
```

### after approving

```text

✓ Read src/add.mjs  3 lines
✓ Edit src/add.mjs  +1 −1
    −   return a - b;
    +   return a + b;

● Fixed the subtraction.

! Changed src/add.mjs (+1 −1) · Tests:
  not run · /diff for details
────────────────────────────────────────
>  Ask anything or describe a change ·…
────────────────────────────────────────
  ws · sol-large · ask mode · ctx 1%






```
