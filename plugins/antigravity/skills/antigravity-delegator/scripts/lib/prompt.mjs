const fallback = value => value === undefined || value === null || value === "" ? "Not specified" : String(value);

/**
 * The read-only profile runs `agy --mode plan`, whose default behaviour is to write an
 * implementation plan and wait for an approval that headless mode never delivers. The flag
 * is what keeps the run from editing files, so it stays; this directive keeps the model
 * from spending the turn on a plan nobody can approve.
 */
export const HEADLESS_DIRECTIVE = [
  "Execution context",
  "This is a headless single-turn run. Nobody can answer a question or approve a plan.",
  "Do not write an implementation plan, do not announce what you are about to do, and do not ask to proceed.",
  "Do the work now and return the finished result in this turn. If you cannot finish it all, return what you verified and name what is left.",
].join("\n");

export function withHeadlessDirective(prompt) {
  const text = String(prompt ?? "");
  if (!text.trim()) return text;
  return text.includes(HEADLESS_DIRECTIVE) ? text : `${text}\n\n${HEADLESS_DIRECTIVE}`;
}

export function buildDelegationPrompt(task) {
  if (!task?.task) throw new Error("A delegated task is required");
  const access = task.accessProfile || "read-only";
  const authorization = access.startsWith("write")
    ? "Workspace-write. Change only files required by the task, within the stated scope."
    : "Read-only. Inspect and report; you must not change files.";
  return [
    "Task", fallback(task.task), "",
    "Workspace and scope", `Workspace: ${fallback(task.workspace)}`, `Scope: ${fallback(task.scope)}`, "",
    "Authorization", authorization, "",
    "Expected deliverable", fallback(task.deliverable), "",
    "Verification command or evidence requirement", fallback(task.verification), "",
    "Stopping condition", fallback(task.stoppingCondition), "",
    "Final response contract", "Return: summary, changed files (if any), verification evidence, and open issues. Preserve errors and uncertainty.", "",
    HEADLESS_DIRECTIVE,
  ].join("\n");
}
