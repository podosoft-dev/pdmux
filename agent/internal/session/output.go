package session

import "strconv"

// The screen protocol has no application window title. Discard OSC 0/1/2 before
// VT parsing: the VT parser treats UTF-8 continuation byte 0x9c inside OSC text
// as ST, leaking the title's suffix into the screen and moving the cursor.
// Keep only a bounded command prefix; even an unterminated title uses no buffer.
type windowTitleFilter struct {
	state   byte
	utf8    int
	prefix  []byte
	command int
}

const (
	outputText byte = iota
	outputEscape
	outputOSCCommand
	outputOSCPass
	outputOSCDrop
	outputOSCPassEscape
	outputOSCDropEscape
)

func (f *windowTitleFilter) filter(input []byte) []byte {
	output := make([]byte, 0, len(input))
	for _, b := range input {
		continuation := f.utf8 > 0 && b&0xc0 == 0x80
		if continuation {
			f.utf8--
		} else {
			f.utf8 = 0
			switch {
			case b >= 0xc2 && b <= 0xdf:
				f.utf8 = 1
			case b >= 0xe0 && b <= 0xef:
				f.utf8 = 2
			case b >= 0xf0 && b <= 0xf4:
				f.utf8 = 3
			}
		}
		terminator := !continuation && (b == '\a' || b == 0x9c || b == 0x18 || b == 0x1a)
		switch f.state {
		case outputText:
			if b == 0x1b {
				f.state = outputEscape
			} else if b == 0x9d && !continuation {
				f.prefix, f.command, f.state = []byte{b}, 1, outputOSCCommand
			} else {
				output = append(output, b)
			}
		case outputEscape:
			if b == ']' {
				f.prefix, f.command, f.state = []byte{0x1b, b}, 2, outputOSCCommand
			} else if b == 0x1b {
				// Consecutive ESC bytes restart the same escape introducer.
			} else {
				output = append(output, 0x1b, b)
				f.state = outputText
			}
		case outputOSCCommand:
			f.prefix = append(f.prefix, b)
			if b == ';' {
				command, err := strconv.Atoi(string(f.prefix[f.command : len(f.prefix)-1]))
				f.state = outputOSCDrop
				if err != nil || command < 0 || command > 2 {
					output = append(output, f.prefix...)
					f.state = outputOSCPass
				}
			} else if terminator || b < '0' || b > '9' || len(f.prefix) >= 18 {
				output = append(output, f.prefix...)
				f.state = outputOSCPass
				if terminator {
					f.state = outputText
				}
			}
		case outputOSCPass:
			output = append(output, b)
			if terminator {
				f.state = outputText
			} else if b == 0x1b {
				f.state = outputOSCPassEscape
			}
		case outputOSCDrop:
			if terminator {
				f.state = outputText
			} else if b == 0x1b {
				f.state = outputOSCDropEscape
			}
		case outputOSCPassEscape:
			output = append(output, b)
			f.state = outputOSCPass
			if b == '\\' || terminator {
				f.state = outputText
			}
		case outputOSCDropEscape:
			f.state = outputOSCDrop
			if b == ']' {
				f.prefix, f.command, f.state = []byte{0x1b, b}, 2, outputOSCCommand
			} else if b == '\\' || terminator {
				f.state = outputText
			} else if b != 0x1b {
				// An escape other than ST cancels the string and starts a new command.
				output = append(output, 0x1b, b)
				f.state = outputText
			}
		}
	}
	return output
}
