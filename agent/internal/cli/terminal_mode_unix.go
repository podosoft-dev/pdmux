//go:build !windows

package cli

func enableOutputVT(int) (func(), error) { return func() {}, nil }
