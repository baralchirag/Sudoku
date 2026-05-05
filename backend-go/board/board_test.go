package board

import "testing"

func TestNewBoardLength(t *testing.T) {
    b := New()
    if len(b) != 81 {
        t.Fatalf("expected length 81, got %d", len(b))
    }
}

func TestIndexRowColConversions(t *testing.T) {
    for idx := 0; idx < 81; idx++ {
        r, c := IndexToRowCol(idx)
        got := RowColToIndex(r, c)
        if got != idx {
            t.Fatalf("roundtrip failed for idx=%d -> %d/%d -> %d", idx, r, c, got)
        }
    }
}

func TestSetGet(t *testing.T) {
    b := New()
    if err := b.Set(0, 5); err != nil {
        t.Fatalf("set failed: %v", err)
    }
    v, err := b.Get(0)
    if err != nil {
        t.Fatalf("get failed: %v", err)
    }
    if v != 5 {
        t.Fatalf("expected 5, got %d", v)
    }
}

func TestIsValidChecks(t *testing.T) {
    b := New()
    // empty board: placing 5 at 0,0 should be valid
    if !IsValid(b, 0, 0, 5) {
        t.Fatalf("expected valid on empty board")
    }
    // row conflict
    if err := b.Set(RowColToIndex(0, 1), 5); err != nil {
        t.Fatalf("set failed: %v", err)
    }
    if IsValid(b, 0, 0, 5) {
        t.Fatalf("expected invalid due to row conflict")
    }
    // reset
    if err := b.Set(RowColToIndex(0, 1), 0); err != nil {
        t.Fatalf("reset failed: %v", err)
    }
    // column conflict
    if err := b.Set(RowColToIndex(1, 0), 6); err != nil {
        t.Fatalf("set failed: %v", err)
    }
    if IsValid(b, 0, 0, 6) {
        t.Fatalf("expected invalid due to column conflict")
    }
    if err := b.Set(RowColToIndex(1, 0), 0); err != nil {
        t.Fatalf("reset failed: %v", err)
    }
    // box conflict
    if err := b.Set(RowColToIndex(1, 1), 7); err != nil {
        t.Fatalf("set failed: %v", err)
    }
    if IsValid(b, 0, 0, 7) {
        t.Fatalf("expected invalid due to box conflict")
    }
}
