'use strict';
//
// Shell-neutral commands for tests that need a "wrapped" status line command. `cat`, `printf`
// and `;` do not exist in cmd.exe, so these build the same behaviour out of node, which every
// machine running the tests has. Paths are double-quoted (cmd and sh both accept that).
//
const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
const node = q(process.execPath);

/** Prints a file to stdout, or stdin to stdout when no file is given (like `cat`). */
const cat = (file) => node + ' -e ' + q(file === undefined
  ? "process.stdin.pipe(process.stdout)"
  : "process.stdout.write(require('fs').readFileSync(process.argv[1]))") + (file === undefined ? '' : ' ' + q(file));

/** Prints text with no trailing newline (like `printf`). Text must not contain double quotes. */
const say = (text) => node + ' -e ' + q("process.stdout.write(process.argv[1])") + ' ' + q(text);

/** Joins two commands: the second runs after the first, in cmd and in sh. */
const then = (a, b) => a + ' && ' + b;

module.exports = { q, node, cat, say, then };
