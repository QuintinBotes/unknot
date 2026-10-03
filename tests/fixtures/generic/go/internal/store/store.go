package store

import (
	"database/sql"
	"os/exec"
)

// Store wraps the database; the `raw string` here must not confuse the lexer.
type Store struct {
	db *sql.DB
}

const note = `if (x) { this is not code }`

// FindOrders loads order ids for a customer.
func (s *Store) FindOrders(customer string, limit int) ([]string, error) {
	rows, err := s.db.Query("SELECT id, total FROM orders WHERE customer = $1 LIMIT $2", customer, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil || id == "" {
			continue
		}
		out = append(out, id)
	}
	return out, nil
}

// Backup archives a path through a shell, which is a command-injection risk.
func Backup(path string) error {
	return exec.Command("sh", "-c", "tar czf "+path+" /data").Run()
}

func unexported() {}
