// Command bridge exercises the real bounded transfer protocol against a disposable home.
package main

import (
	"bufio"
	"fmt"
	"os"

	"github.com/podosoft-dev/pdmux/agent/internal/fs"
	"github.com/podosoft-dev/pdmux/agent/internal/protocol"
)

func main() {
	if len(os.Args) != 2 { panic("one disposable home is required") }
	root, err := fs.Open(os.Args[1])
	if err != nil { panic(err) }
	defer root.Close()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	for scanner.Scan() {
		frame, err := protocol.DecodeDownstream(scanner.Bytes())
		if err != nil { panic(err) }
		request, ok := frame.(*protocol.FsTransferFrame)
		if !ok { panic("expected transfer frame") }
		result := fs.Transfer(root, request.Transfer)
		data, err := protocol.EncodeUpstream(&protocol.FsTransferResultFrame{Result: result})
		if err != nil { panic(err) }
		fmt.Println(string(data))
	}
	if err := scanner.Err(); err != nil { panic(err) }
}
