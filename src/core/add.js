/**
 * Add two finite numbers.
 *
 * @param {number} first
 * @param {number} second
 * @returns {number}
 */
export function add(first, second) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) {
    throw new TypeError("Both operands must be finite numbers");
  }

  return first + second;
}
