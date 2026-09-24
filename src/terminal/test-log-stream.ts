import { createWorkflowEventBus } from "../workflow/events.js"
import { createTerminalUI } from "./ui.js"

const prefixes = ["[Agent]", "[Workflow]", "[Issue]", "[Review]", "[Gate]", "[FinalGate]", "[TestStatus]"]
const messages = [
  "Starting task",
  "Reading configuration",
  "Waiting for agent output",
  "Review baseline advanced",
  "Task completed successfully",
]

const main = async () => {
  const eventBus = createWorkflowEventBus()
  const ui = await createTerminalUI(eventBus)
  const sink = ui.getLogSink()

  eventBus.publish({ type: "issue_change", issueIndex: 0, issueCount: 1, issueTitle: "terminal log stream" })
  eventBus.publish({ type: "phase_change", phase: "implement" })
  eventBus.publish({ type: "agent_state_change", agent: "implementer", status: "working" })

  for (let index = 0; index < 120; index += 1) {
    const prefix = prefixes[index % prefixes.length]
    const message = messages[index % messages.length]
    const suffix = index % 4 === 0 ? ` (step ${index + 1}/120)` : ""
    const output = `${prefix} ${message}${suffix}`
    if (index % 11 === 0) sink.logStderr(`${output} - warning`)
    else sink.log(output)
  }

  sink.log("[Workflow] Logs printed. Press Ctrl+C to exit.")
  process.stdin.resume()
}

void main()
