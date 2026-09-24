# 07-scrolled-up-stream: Long streaming answer while the user scrolled up

## 80x24

- enter -> user line: 1 ms · enter -> activity: 17 ms · full redraws (screen+scrollback clears): 0 · bytes written: 108966
- viewportY before=42 after=42 (base 92); full redraws while scrolled up: 0

### user scrolled up 8 lines

```text
  - Point 18: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 19: the renderer keeps text readable while the answer grows line by
    line.
  - Point 20: the renderer keeps text readable while the answer grows line by
    line.
  - Point 21: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 22: the renderer keeps text readable while the answer grows line by
    line.
  - Point 23: the renderer keeps text readable while the answer grows line by
    line.

  Section 3

  - Point 25: the renderer keeps text readable while the answer grows line by
    line.
  - Point 26: the renderer keeps text readable while the answer grows line by
    line.
  - Point 27: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 28: the renderer keeps text readable while the answer grows line by
    line.
  - Point 29: the renderer keeps text readable while the answer grows line by
```

### more output arrived (viewport)

```text
  - Point 18: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 19: the renderer keeps text readable while the answer grows line by
    line.
  - Point 20: the renderer keeps text readable while the answer grows line by
    line.
  - Point 21: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 22: the renderer keeps text readable while the answer grows line by
    line.
  - Point 23: the renderer keeps text readable while the answer grows line by
    line.

  Section 3

  - Point 25: the renderer keeps text readable while the answer grows line by
    line.
  - Point 26: the renderer keeps text readable while the answer grows line by
    line.
  - Point 27: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 28: the renderer keeps text readable while the answer grows line by
    line.
  - Point 29: the renderer keeps text readable while the answer grows line by
```

### answer done (bottom)

```text
  - Point 51: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 52: the renderer keeps text readable while the answer grows line by
    line.
  - Point 53: the renderer keeps text readable while the answer grows line by
    line.
  - Point 54: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 55: the renderer keeps text readable while the answer grows line by
    line.
  - Point 56: the renderer keeps text readable while the answer grows line by
    line.
  - Point 57: the renderer keeps streaming readable while the answer grows line
    by line.
  - Point 58: the renderer keeps text readable while the answer grows line by
    line.
  - Point 59: the renderer keeps text readable while the answer grows line by
    line.
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%


```

## 120x40

- enter -> user line: 1 ms · enter -> activity: 50 ms · full redraws (screen+scrollback clears): 0 · bytes written: 117438
- viewportY before=0 after=0 (base 31); full redraws while scrolled up: 0

### user scrolled up 8 lines

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> explain the renderer in detail

● Section 1

  - Point 1: the renderer keeps text readable while the answer grows line by line.
  - Point 2: the renderer keeps text readable while the answer grows line by line.
  - Point 3: the renderer keeps streaming readable while the answer grows line by line.
  - Point 4: the renderer keeps text readable while the answer grows line by line.
  - Point 5: the renderer keeps text readable while the answer grows line by line.
  - Point 6: the renderer keeps streaming readable while the answer grows line by line.
  - Point 7: the renderer keeps text readable while the answer grows line by line.
  - Point 8: the renderer keeps text readable while the answer grows line by line.
  - Point 9: the renderer keeps streaming readable while the answer grows line by line.
  - Point 10: the renderer keeps text readable while the answer grows line by line.
  - Point 11: the renderer keeps text readable while the answer grows line by line.

  Section 2

  - Point 13: the renderer keeps text readable while the answer grows line by line.
  - Point 14: the renderer keeps text readable while the answer grows line by line.
  - Point 15: the renderer keeps streaming readable while the answer grows line by line.
  - Point 16: the renderer keeps text readable while the answer grows line by line.
  - Point 17: the renderer keeps text readable while the answer grows line by line.
  - Point 18: the renderer keeps streaming readable while the answer grows line by line.
  - Point 19: the renderer keeps text readable while the answer grows line by line.
  - Point 20: the renderer keeps text readable while the answer grows line by line.
  - Point 21: the renderer keeps streaming readable while the answer grows line by line.
  - Point 22: the renderer keeps text readable while the answer grows line by line.
  - Point 23: the renderer keeps text readable while the answer grows line by line.

  Section 3

  - Point 25: the renderer keeps text readable while the answer grows line by line.
  - Point 26: the renderer keeps text readable while the answer grows line by line.
  - Point 27: the renderer keeps streaming readable while the answer grows line by line.
  - Point 28: the renderer keeps text readable while the answer grows line by line.
  - Point 29: the renderer keeps text readable while the answer grows line by line.
```

### more output arrived (viewport)

```text
Synorch 0.3.0 · ws (master) · sol-large · autonomous
! Sandbox is partial: commands you allow can write outside this folder

> explain the renderer in detail

● Section 1

  - Point 1: the renderer keeps text readable while the answer grows line by line.
  - Point 2: the renderer keeps text readable while the answer grows line by line.
  - Point 3: the renderer keeps streaming readable while the answer grows line by line.
  - Point 4: the renderer keeps text readable while the answer grows line by line.
  - Point 5: the renderer keeps text readable while the answer grows line by line.
  - Point 6: the renderer keeps streaming readable while the answer grows line by line.
  - Point 7: the renderer keeps text readable while the answer grows line by line.
  - Point 8: the renderer keeps text readable while the answer grows line by line.
  - Point 9: the renderer keeps streaming readable while the answer grows line by line.
  - Point 10: the renderer keeps text readable while the answer grows line by line.
  - Point 11: the renderer keeps text readable while the answer grows line by line.

  Section 2

  - Point 13: the renderer keeps text readable while the answer grows line by line.
  - Point 14: the renderer keeps text readable while the answer grows line by line.
  - Point 15: the renderer keeps streaming readable while the answer grows line by line.
  - Point 16: the renderer keeps text readable while the answer grows line by line.
  - Point 17: the renderer keeps text readable while the answer grows line by line.
  - Point 18: the renderer keeps streaming readable while the answer grows line by line.
  - Point 19: the renderer keeps text readable while the answer grows line by line.
  - Point 20: the renderer keeps text readable while the answer grows line by line.
  - Point 21: the renderer keeps streaming readable while the answer grows line by line.
  - Point 22: the renderer keeps text readable while the answer grows line by line.
  - Point 23: the renderer keeps text readable while the answer grows line by line.

  Section 3

  - Point 25: the renderer keeps text readable while the answer grows line by line.
  - Point 26: the renderer keeps text readable while the answer grows line by line.
  - Point 27: the renderer keeps streaming readable while the answer grows line by line.
  - Point 28: the renderer keeps text readable while the answer grows line by line.
  - Point 29: the renderer keeps text readable while the answer grows line by line.
```

### answer done (bottom)

```text
  - Point 30: the renderer keeps streaming readable while the answer grows line by line.
  - Point 31: the renderer keeps text readable while the answer grows line by line.
  - Point 32: the renderer keeps text readable while the answer grows line by line.
  - Point 33: the renderer keeps streaming readable while the answer grows line by line.
  - Point 34: the renderer keeps text readable while the answer grows line by line.
  - Point 35: the renderer keeps text readable while the answer grows line by line.

  Section 4

  - Point 37: the renderer keeps text readable while the answer grows line by line.
  - Point 38: the renderer keeps text readable while the answer grows line by line.
  - Point 39: the renderer keeps streaming readable while the answer grows line by line.
  - Point 40: the renderer keeps text readable while the answer grows line by line.
  - Point 41: the renderer keeps text readable while the answer grows line by line.
  - Point 42: the renderer keeps streaming readable while the answer grows line by line.
  - Point 43: the renderer keeps text readable while the answer grows line by line.
  - Point 44: the renderer keeps text readable while the answer grows line by line.
  - Point 45: the renderer keeps streaming readable while the answer grows line by line.
  - Point 46: the renderer keeps text readable while the answer grows line by line.
  - Point 47: the renderer keeps text readable while the answer grows line by line.

  Section 5

  - Point 49: the renderer keeps text readable while the answer grows line by line.
  - Point 50: the renderer keeps text readable while the answer grows line by line.
  - Point 51: the renderer keeps streaming readable while the answer grows line by line.
  - Point 52: the renderer keeps text readable while the answer grows line by line.
  - Point 53: the renderer keeps text readable while the answer grows line by line.
  - Point 54: the renderer keeps streaming readable while the answer grows line by line.
  - Point 55: the renderer keeps text readable while the answer grows line by line.
  - Point 56: the renderer keeps text readable while the answer grows line by line.
  - Point 57: the renderer keeps streaming readable while the answer grows line by line.
  - Point 58: the renderer keeps text readable while the answer grows line by line.
  - Point 59: the renderer keeps text readable while the answer grows line by line.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ws · master · sol-large · auto mode · ctx 1%


```

## 40x20

- enter -> user line: 1 ms · enter -> activity: 49 ms · full redraws (screen+scrollback clears): 0 · bytes written: 101822
- viewportY before=75 after=75 (base 143); full redraws while scrolled up: 0

### user scrolled up 8 lines

```text
  - Point 23: the renderer keeps text
    readable while the answer grows line
    by line.

  Section 3

  - Point 25: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 26: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 27: the renderer keeps
    streaming readable while the answer
    grows line by line.
  - Point 28: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 29: the renderer keeps text
    readable while the answer grows line
```

### more output arrived (viewport)

```text
  - Point 23: the renderer keeps text
    readable while the answer grows line
    by line.

  Section 3

  - Point 25: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 26: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 27: the renderer keeps
    streaming readable while the answer
    grows line by line.
  - Point 28: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 29: the renderer keeps text
    readable while the answer grows line
```

### answer done (bottom)

```text
  - Point 55: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 56: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 57: the renderer keeps
    streaming readable while the answer
    grows line by line.
  - Point 58: the renderer keeps text
    readable while the answer grows line
    by line.
  - Point 59: the renderer keeps text
    readable while the answer grows line
    by line.
────────────────────────────────────────

────────────────────────────────────────
  ws · master · sol-large · auto mode...

```
