/**
 * Reading a secret from the terminal without echoing it.
 *
 * One copy, shared by every operational script that needs a credential, because
 * three copies of a security-relevant helper is three chances for one of them to
 * be the wrong one.
 *
 * ## Why not readline
 *
 * The obvious approach — `readline.createInterface({ input: process.stdin,
 * output: someSink, terminal: true })` — looks like it hides input, because
 * readline echoes keystrokes to `output` and `output` goes nowhere. It is not
 * reliable: whether the *terminal itself* echoes depends on termios ECHO, which
 * readline manages as a side effect of raw mode rather than as a contract. Tested
 * under a pty, the typed secret appeared on screen.
 *
 * So this sets raw mode explicitly — which clears ECHO — reads bytes itself, and
 * never writes a character of the secret anywhere. That is the property being
 * relied on, so it is the property the code states.
 *
 * Handles backspace, Ctrl-C and Ctrl-D, and restores the terminal on every exit
 * path. A script that leaves a terminal in raw mode is a script that eats the
 * next person's shell session.
 */

/**
 * Prompts on stdout and reads a line from stdin without echoing it.
 *
 * @param {string} question Text to show before reading.
 * @returns {Promise<string>} The trimmed input.
 */
export function promptHidden(question) {
  const input = process.stdin;

  // Not a terminal — piped input, as in a test. There is nothing to echo and no
  // raw mode to set; read a line and return it.
  if (!input.isTTY) {
    return new Promise((resolve, reject) => {
      let buffer = "";
      input.setEncoding("utf8");
      const onData = (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline !== -1) {
          input.off("data", onData);
          input.off("end", onEnd);
          input.pause();
          finish(buffer.slice(0, newline));
        }
      };
      const onEnd = () => finish(buffer);
      const finish = (value) => {
        const trimmed = value.trim();
        if (trimmed) resolve(trimmed);
        else reject(new Error("No value supplied."));
      };
      input.on("data", onData);
      input.on("end", onEnd);
      input.resume();
    });
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(question);

    let value = "";
    let settled = false;

    const restore = () => {
      input.off("data", onData);
      try {
        input.setRawMode(false);
      } catch {
        // Already restored, or no longer a TTY. Nothing to do.
      }
      input.pause();
    };

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      restore();
      process.stdout.write("\n");
      fn(arg);
    };

    const onData = (chunk) => {
      for (const ch of chunk) {
        switch (ch) {
          case "\r":
          case "\n": {
            const trimmed = value.trim();
            // The secret is zeroed from the closure before resolving, so it is not
            // retained here after the caller has it.
            value = "";
            if (trimmed) done(resolve, trimmed);
            else done(reject, new Error("No value supplied."));
            return;
          }
          case "\u0003": // Ctrl-C
            value = "";
            done(reject, new Error("Cancelled."));
            return;
          case "\u0004": // Ctrl-D
            value = "";
            done(reject, new Error("No value supplied."));
            return;
          case "\u007f": // Backspace
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            // Ignore other control characters rather than putting them in a
            // credential, where they would produce a confusing auth failure.
            if (ch >= " ") value += ch;
            break;
        }
      }
    };

    input.setEncoding("utf8");
    // Raw mode clears termios ECHO. This is the line that makes the input hidden;
    // everything else is bookkeeping.
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);

    // If the process dies some other way, do not leave the terminal in raw mode.
    process.once("exit", restore);
  });
}
