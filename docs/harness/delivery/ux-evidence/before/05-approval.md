# 05-approval: Approval prompt (ask mode)

## 80x24

- enter -> user line: 1 ms · enter -> activity: 32 ms · full redraws (screen+scrollback clears): 0 · bytes written: 6155

### approval prompt

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix add

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs

? Waiting for you… · 0s · 160 tokens
────────────────────────────────────────────────────────────────────────────────

──── Allow Synorch to edit files?                                           ────
  ws   apply_patch [workspace-write] write src/add.mjs
       why          workspace-write needs your approval
       consequence  changes files in the workspace (/undo reverts Synorch's
     edits)
     → 1. Allow once
       2. Allow all edits (switch to auto mode)
       3. Deny
       4. Deny and tell Synorch why
       1-9 or arrows + Enter · Esc denies

```

### after approving

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix add

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;
✓ Allowed

● Fixed the subtraction.
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · ctx 1%





```

## 120x40

- enter -> user line: 1 ms · enter -> activity: 21 ms · full redraws (screen+scrollback clears): 0 · bytes written: 7294

### approval prompt

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix add

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs

? Waiting for you… · 0s · 160 tokens
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · ctx 1%















       Allow Synorch to edit files?
         apply_patch [workspace-write] write src/add.mjs
         why          workspace-write needs your approval
         consequence  changes files in the workspace (/undo reverts Synorch's edits)
       → 1. Allow once
         2. Allow all edits (switch to auto mode)
         3. Deny
         4. Deny and tell Synorch why
         1-9 or arrows + Enter · Esc denies

```

### after approving

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> fix add

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;
✓ Allowed

● Fixed the subtraction.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · ask mode · ctx 1%





















```

## 40x20

- enter -> user line: 1 ms · enter -> activity: 22 ms · full redraws (screen+scrollback clears): 0 · bytes written: 4220

### approval prompt

```text
Synorch 0.3.0 · ws (master) · sol-large
· autonomous
! Sandbox is partial: commands you allow
can write outside this folder

>  Allow Synorch to edit files?
     apply_patch [workspace-write]
●  write src/add.mjs
     why          workspace-write
   needs your approval
●    consequence  changes files in
   the workspace (/undo reverts
?  Synorch's edits)
── → 1. Allow once                    ──
     2. Allow all edits (switch to
──   3. Deny                          ──
     4. Deny and tell Synorch why     ..
     1-9 or arrows + Enter · Esc
   denies

```

### after approving

```text
· autonomous
! Sandbox is partial: commands you allow
can write outside this folder

> fix add

● Read src/add.mjs
  ⎿ 3 lines

● Edit src/add.mjs
  ⎿ +1 −1
     −   return a - b;
     +   return a + b;
✓ Allowed

● Fixed the subtraction.
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · ask mode ...
```
