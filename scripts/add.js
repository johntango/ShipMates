#!/usr/bin/env node

import { add } from "../src/core/add.js";

const operands = process.argv.slice(2);

if (operands.length !== 2) {
  console.error("Usage: node scripts/add.js <number> <number>");
  process.exitCode = 1;
} else {
  const numbers = operands.map(Number);

  try {
    console.log(add(numbers[0], numbers[1]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
