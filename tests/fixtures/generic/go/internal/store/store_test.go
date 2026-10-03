package store

import "testing"

func TestBackup(t *testing.T) {
	if err := Backup("x"); err != nil {
		t.Fatal(err)
	}
}
