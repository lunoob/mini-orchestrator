import { runSkillCli } from "../src/cli/skill.js"

void runSkillCli(process.argv.slice(2)).then(code => {
  process.exitCode = code
})
