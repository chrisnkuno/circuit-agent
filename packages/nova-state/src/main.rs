use std::io::{self, BufRead, Write};

use nova_state::{handle_request, Request, Response};

const MAX_REQUEST_BYTES: usize = 1_048_576;

enum InputLine {
    End,
    Data(String),
    TooLarge,
    InvalidUtf8,
}

/// Reads and drains exactly one line while retaining at most MAX_REQUEST_BYTES.
/// This keeps an untrusted parent process from forcing an unbounded allocation.
fn read_request_line(reader: &mut impl BufRead) -> io::Result<InputLine> {
    let mut bytes = Vec::with_capacity(4096);
    let mut too_large = false;
    let mut saw_input = false;

    loop {
        let (consumed, complete) = {
            let available = reader.fill_buf()?;
            if available.is_empty() {
                if !saw_input {
                    return Ok(InputLine::End);
                }
                return if too_large {
                    Ok(InputLine::TooLarge)
                } else {
                    Ok(match String::from_utf8(bytes) {
                        Ok(line) => InputLine::Data(line),
                        Err(_) => InputLine::InvalidUtf8,
                    })
                };
            }

            saw_input = true;
            let newline = available.iter().position(|byte| *byte == b'\n');
            let content_length = newline.unwrap_or(available.len());
            if !too_large {
                if bytes.len().saturating_add(content_length) > MAX_REQUEST_BYTES {
                    too_large = true;
                    bytes.clear();
                } else {
                    bytes.extend_from_slice(&available[..content_length]);
                }
            }
            (
                content_length + usize::from(newline.is_some()),
                newline.is_some(),
            )
        };
        reader.consume(consumed);

        if complete {
            return if too_large {
                Ok(InputLine::TooLarge)
            } else {
                Ok(match String::from_utf8(bytes) {
                    Ok(line) => InputLine::Data(line),
                    Err(_) => InputLine::InvalidUtf8,
                })
            };
        }
    }
}

fn main() {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut stdout = io::BufWriter::new(io::stdout().lock());

    loop {
        let response = match read_request_line(&mut input) {
            Ok(InputLine::End) => break,
            Ok(InputLine::Data(line)) if line.trim().is_empty() => continue,
            Ok(InputLine::TooLarge) => {
                Response::invalid_request(format!("request exceeds {MAX_REQUEST_BYTES} bytes"))
            }
            Ok(InputLine::InvalidUtf8) => Response::invalid_request("request must be valid UTF-8"),
            Ok(InputLine::Data(line)) => match serde_json::from_str::<Request>(&line) {
                Ok(request) => handle_request(request),
                Err(error) => Response::invalid_request(error.to_string()),
            },
            Err(error) => Response::internal(None, error.to_string()),
        };

        if serde_json::to_writer(&mut stdout, &response).is_err() {
            break;
        }
        if stdout.write_all(b"\n").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn bounded_reader_drains_an_oversized_line_and_recovers() {
        let mut input = vec![b'x'; MAX_REQUEST_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = Cursor::new(input);

        assert!(matches!(
            read_request_line(&mut reader).unwrap(),
            InputLine::TooLarge
        ));
        assert!(matches!(
            read_request_line(&mut reader).unwrap(),
            InputLine::Data(line) if line == "{}"
        ));
    }

    #[test]
    fn bounded_reader_rejects_invalid_utf8_without_losing_the_next_line() {
        let mut reader = Cursor::new(vec![0xff, b'\n', b'{', b'}', b'\n']);
        assert!(matches!(
            read_request_line(&mut reader).unwrap(),
            InputLine::InvalidUtf8
        ));
        assert!(matches!(
            read_request_line(&mut reader).unwrap(),
            InputLine::Data(line) if line == "{}"
        ));
    }
}
