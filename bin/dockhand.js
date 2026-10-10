#!/usr/bin/env node
// Entry point for the `dockhand` command.
import { main } from '../src/cli.js';

main(process.argv.slice(2));