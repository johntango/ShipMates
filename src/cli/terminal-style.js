const red = "\u001b[31;1m";
const reset = "\u001b[0m";

export function humanInputRequired(message, { color = terminalColor() } = {}) {
  const text = `HUMAN INPUT REQUIRED: ${String(message || "").trim()}`;
  return color ? `${red}${text}${reset}` : text;
}

export function appearsToRequireHumanInput(message) {
  const text = String(message || "").trim();
  return /\?\s*$/u.test(text) ||
    /\b(?:please|need you to|requires? (?:your|human)|human (?:approval|decision|input)|should I|choose|select|approve|confirm|authorize|permission)\b/iu.test(text);
}

function terminalColor() {
  return Boolean(process.stderr.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}
