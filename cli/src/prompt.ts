import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function prompt(question: string) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
}
