package main

import (
	"fmt"

	"github.com/chiragbaral/sudoku/backend-go/board"
)

func main() {
	b := board.New()
	fmt.Printf("New board length=%d\n", len(b))
	r, c := board.IndexToRowCol(10)
	fmt.Printf("index 10 -> row=%d col=%d\n", r, c)
	idx := board.RowColToIndex(1, 1)
	fmt.Printf("row=1 col=1 -> index=%d\n", idx)
}
