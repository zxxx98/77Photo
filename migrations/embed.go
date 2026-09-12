package migrations

import "embed"

// FS contains the versioned schema migrations shipped with the binary.
// Keeping SQL in files makes schema changes reviewable while embedding them
// removes a runtime dependency on the source tree.
//
//go:embed *.sql
var FS embed.FS
