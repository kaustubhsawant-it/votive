#!/usr/bin/env node
'use strict';
// Compatibility shim for the name before Votive. Hooks written by an earlier version call this
// path; it runs the renamed script with the same arguments and input. install.sh copies it next
// to votive-event.js. Delete it when no install can still carry the old path.
require('./votive-event.js');
