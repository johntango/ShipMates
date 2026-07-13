import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readFirstmateMessage } from "../src/cli/firstmate-message.js";

test("uses a prompt supplied as command-line arguments", async () => {
  const message = await readFirstmateMessage({
    messageParts: ["Inspect", "the", "implementation"],
  });

  assert.equal(message, "Inspect the implementation");
});

test("asks for a prompt when command-line arguments omit it", async () => {
  const prompts = [];
  const answers = ["  ", "Review the current implementation  "];
  const message = await readFirstmateMessage({
    askMessage: async (prompt) => {
      prompts.push(prompt);
      return answers.shift();
    },
  });

  assert.equal(message, "Review the current implementation");
  assert.deepEqual(prompts, ["You: ", "You: "]);
});

test("accepts a prompt piped over stdin", async () => {
  const message = await readFirstmateMessage({
    input: Readable.from(["Inspect the current ", "implementation\n"]),
  });

  assert.equal(message, "Inspect the current implementation");
});

test("rejects empty piped stdin", async () => {
  await assert.rejects(
    readFirstmateMessage({ input: Readable.from([]) }),
    /requires a non-empty prompt/u,
  );
});
